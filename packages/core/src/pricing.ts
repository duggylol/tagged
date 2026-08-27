import { getPlatform } from './platforms';
import type { Comp, PlatformId, PriceSuggestion } from './types';

/**
 * The pricing engine.
 *
 * Note what this module does NOT do: call a model. Pricing is statistics over
 * a comp set, and a language model is both more expensive and less accurate at
 * it than twenty lines of arithmetic. The model's job upstream is to describe
 * the item well enough that we retrieve the right comps.
 */

const MIN_SAMPLE_FOR_CONFIDENCE = 5;
const RECENCY_HALF_LIFE_DAYS = 45;

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const lo = sorted[base]!;
  const hi = sorted[base + 1];
  return hi === undefined ? lo : lo + rest * (hi - lo);
}

function daysBetween(iso: string, now: Date): number {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return RECENCY_HALF_LIFE_DAYS * 4;
  return Math.max(0, (now.getTime() - then) / 86_400_000);
}

/**
 * A comp's weight decays with age and with dissimilarity. A six-month-old
 * listing for a slightly different colorway should not move the number as
 * much as last week's sale of the exact thing.
 */
function weightOf(comp: Comp, now: Date): number {
  const ageDays = daysBetween(comp.observedAt, now);
  const recency = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
  const similarity = Math.max(0, Math.min(1, comp.similarity));

  // A confirmed sale is worth far more than somebody's asking price.
  const sourceWeight =
    comp.source === 'internal_sold' ? 1.0
    : comp.source === 'user_history' ? 0.9
    : comp.source === 'manual' ? 0.8
    : 0.45; // ebay_active — an ask, not a sale

  return recency * similarity * sourceWeight;
}

function weightedQuantile(
  entries: Array<{ value: number; weight: number }>,
  q: number,
): number {
  if (entries.length === 0) return 0;
  const sorted = [...entries].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, e) => sum + e.weight, 0);
  if (total <= 0) return quantile(sorted.map((e) => e.value), q);

  const target = total * q;
  let running = 0;
  for (const entry of sorted) {
    running += entry.weight;
    if (running >= target) return entry.value;
  }
  return sorted[sorted.length - 1]!.value;
}

export interface PricingOptions {
  /** Nudge the whole suggestion. 1.0 is neutral; 0.9 prices to move. */
  aggressiveness?: number;
  /** Never suggest below this. Protects against a thin, cheap comp set. */
  minPriceCents?: number;
  now?: Date;
}

/**
 * Turn a comp set into a price. Returns a low-confidence suggestion rather
 * than throwing when comps are thin — the UI shows the confidence and lets
 * the seller override, which is better than refusing to answer.
 */
export function suggestPrice(comps: Comp[], opts: PricingOptions = {}): PriceSuggestion {
  const now = opts.now ?? new Date();
  const aggressiveness = opts.aggressiveness ?? 1.0;
  const minPrice = opts.minPriceCents ?? 500;

  const usable = comps.filter((c) => c.priceCents > 0 && c.similarity > 0.2);

  if (usable.length === 0) {
    return {
      listPriceCents: minPrice,
      floorPriceCents: minPrice,
      medianCents: minPrice,
      p25Cents: minPrice,
      p75Cents: minPrice,
      sampleSize: 0,
      confidence: 0,
      rationale:
        'No comparable listings found. This is a floor placeholder, not a valuation — price it yourself.',
    };
  }

  const entries = usable.map((c) => ({ value: c.priceCents, weight: weightOf(c, now) }));

  const median = weightedQuantile(entries, 0.5);
  const p25 = weightedQuantile(entries, 0.25);
  const p75 = weightedQuantile(entries, 0.75);

  // A wide interquartile range relative to the median means the market
  // disagrees with itself, which is exactly when we should be less certain.
  const spread = median > 0 ? (p75 - p25) / median : 1;
  const sampleFactor = Math.min(1, usable.length / MIN_SAMPLE_FOR_CONFIDENCE);
  const spreadFactor = Math.max(0, 1 - Math.min(1, spread));
  const soldShare =
    usable.filter((c) => c.source === 'internal_sold' || c.source === 'user_history').length /
    usable.length;

  const confidence = Number(
    (sampleFactor * 0.4 + spreadFactor * 0.35 + soldShare * 0.25).toFixed(2),
  );

  // List slightly above median so there is room to accept an offer, floor at
  // the 25th percentile so the seller does not accept below market.
  const listPrice = Math.max(minPrice, Math.round(median * 1.08 * aggressiveness));
  const floorPrice = Math.max(minPrice, Math.round(p25 * 0.95 * aggressiveness));

  const soldComps = usable.filter((c) => typeof c.daysToSale === 'number');
  const expectedDaysToSale =
    soldComps.length >= 3
      ? Math.round(
          quantile(
            soldComps.map((c) => c.daysToSale!).sort((a, b) => a - b),
            0.5,
          ),
        )
      : undefined;

  return {
    listPriceCents: roundToCharmPrice(listPrice),
    floorPriceCents: roundToCharmPrice(floorPrice),
    medianCents: Math.round(median),
    p25Cents: Math.round(p25),
    p75Cents: Math.round(p75),
    sampleSize: usable.length,
    confidence,
    expectedDaysToSale,
    rationale: buildRationale(usable, median, confidence, expectedDaysToSale),
  };
}

function buildRationale(
  comps: Comp[],
  median: number,
  confidence: number,
  days: number | undefined,
): string {
  const sold = comps.filter((c) => c.source === 'internal_sold' || c.source === 'user_history').length;
  const active = comps.length - sold;
  const parts: string[] = [];

  parts.push(
    `Median of ${comps.length} comparable${comps.length === 1 ? '' : 's'} ` +
      `(${sold} sold, ${active} active) is $${(median / 100).toFixed(2)}.`,
  );
  if (days !== undefined) parts.push(`Similar items sold in about ${days} days.`);
  if (confidence < 0.4) {
    parts.push('Confidence is low — thin or inconsistent comps. Treat this as a starting point.');
  } else if (confidence < 0.7) {
    parts.push('Moderate confidence. Worth a sanity check before publishing.');
  }
  return parts.join(' ');
}

/**
 * Resale prices cluster on charm points. $24 reads as considered; $23.87 reads
 * as machine output and gets scrolled past.
 */
export function roundToCharmPrice(cents: number): number {
  if (cents < 1000) return Math.max(100, Math.round(cents / 100) * 100);
  if (cents < 5000) {
    // Nearest $1, ending in 8 or 9 where it does not distort much.
    const dollars = Math.round(cents / 100);
    return dollars * 100 - (dollars % 5 === 0 ? 100 : 0);
  }
  return Math.round(cents / 500) * 500;
}

/** Apply a platform's sticker multiplier to a base suggestion. */
export function priceForPlatform(base: PriceSuggestion, platform: PlatformId): number {
  const spec = getPlatform(platform);
  return roundToCharmPrice(Math.round(base.listPriceCents * spec.priceMultiplier));
}

/**
 * How much to cut a listing that has not moved. Escalates with age rather
 * than dropping a flat 10% every time, because a 90-day item needs a real cut
 * and a 35-day item usually just needs a nudge.
 */
export function suggestPriceDrop(
  currentPriceCents: number,
  daysListed: number,
  floorPriceCents: number,
): { newPriceCents: number; dropPercent: number; reason: string } | null {
  let dropPercent = 0;
  let reason = '';

  if (daysListed >= 90) {
    dropPercent = 0.2;
    reason = 'Listed over 90 days. A 20% cut is usually what clears aged inventory.';
  } else if (daysListed >= 60) {
    dropPercent = 0.12;
    reason = 'Listed over 60 days with no sale. Time for a meaningful cut.';
  } else if (daysListed >= 30) {
    dropPercent = 0.07;
    reason = 'Listed over 30 days. A small drop often re-surfaces it in search.';
  } else {
    return null;
  }

  const proposed = roundToCharmPrice(Math.round(currentPriceCents * (1 - dropPercent)));
  if (proposed <= floorPriceCents) {
    if (currentPriceCents <= floorPriceCents) return null;
    return {
      newPriceCents: floorPriceCents,
      dropPercent: 1 - floorPriceCents / currentPriceCents,
      reason: `${reason} Capped at your floor price.`,
    };
  }
  return { newPriceCents: proposed, dropPercent, reason };
}
