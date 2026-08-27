import type { Item, PlatformId, Sale } from './types';

/**
 * Dashboard metrics.
 *
 * The bias throughout is toward numbers a reseller runs their business on —
 * net profit, sell-through, cash tied up — rather than the gross-revenue
 * vanity metrics every competing tool leads with.
 */

const DAY_MS = 86_400_000;

function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  return Math.floor((now.getTime() - then) / DAY_MS);
}

export interface DashboardMetrics {
  /** Confirmed sales only. */
  grossRevenueCents: number;
  netProfitCents: number;
  totalFeesCents: number;
  salesCount: number;
  averageSaleCents: number;
  averageProfitCents: number;
  averageMargin: number;
  /** Sold ÷ (sold + currently listed). */
  sellThroughRate: number;
  /** Median days from first listed to sold. */
  medianDaysToSale: number | null;
  /** Cost basis of everything unsold. Money sitting on a rack. */
  cashTiedUpCents: number;
  activeCount: number;
  draftCount: number;
  /** Listed 60+ days and still unsold. */
  agingCount: number;
  /** Listed 90+ days. The subset that needs a real price cut. */
  staleCount: number;
  awaitingConfirmCount: number;
}

export interface MetricsWindow {
  /** Only count sales confirmed on or after this date. */
  since?: Date;
  now?: Date;
}

export function computeDashboardMetrics(
  items: Item[],
  sales: Sale[],
  window: MetricsWindow = {},
): DashboardMetrics {
  const now = window.now ?? new Date();
  const since = window.since?.getTime() ?? 0;

  const confirmed = sales.filter(
    (s) => s.confirmedAt !== null && new Date(s.confirmedAt).getTime() >= since,
  );

  const grossRevenueCents = sum(confirmed.map((s) => s.salePriceCents));
  const totalFeesCents = sum(confirmed.map((s) => s.feesCents + s.shippingCents));
  const netProfitCents = sum(confirmed.map((s) => s.profitCents));
  const salesCount = confirmed.length;

  const activeItems = items.filter((i) => i.status === 'active');
  const draftItems = items.filter((i) => i.status === 'draft');
  const soldItems = items.filter((i) => i.status === 'sold');
  const unsoldItems = items.filter((i) => i.status !== 'sold' && i.status !== 'archived');

  const denominator = soldItems.length + activeItems.length;
  const sellThroughRate = denominator > 0 ? soldItems.length / denominator : 0;

  const saleDurations = soldItems
    .map((i) => {
      if (!i.listedAt || !i.soldAt) return null;
      const days = Math.floor(
        (new Date(i.soldAt).getTime() - new Date(i.listedAt).getTime()) / DAY_MS,
      );
      return Number.isFinite(days) && days >= 0 ? days : null;
    })
    .filter((d): d is number => d !== null)
    .sort((a, b) => a - b);

  const agingCount = activeItems.filter((i) => (daysSince(i.listedAt, now) ?? 0) >= 60).length;
  const staleCount = activeItems.filter((i) => (daysSince(i.listedAt, now) ?? 0) >= 90).length;

  return {
    grossRevenueCents,
    netProfitCents,
    totalFeesCents,
    salesCount,
    averageSaleCents: salesCount > 0 ? Math.round(grossRevenueCents / salesCount) : 0,
    averageProfitCents: salesCount > 0 ? Math.round(netProfitCents / salesCount) : 0,
    averageMargin: grossRevenueCents > 0 ? netProfitCents / grossRevenueCents : 0,
    sellThroughRate,
    medianDaysToSale: median(saleDurations),
    cashTiedUpCents: sum(unsoldItems.map((i) => i.costBasisCents ?? 0)),
    activeCount: activeItems.length,
    draftCount: draftItems.length,
    agingCount,
    staleCount,
    awaitingConfirmCount: items.filter((i) => i.status === 'awaiting_confirm').length,
  };
}

// ---------------------------------------------------------------------------
// Platform scorecard
// ---------------------------------------------------------------------------

export interface PlatformPerformance {
  platform: PlatformId;
  salesCount: number;
  grossRevenueCents: number;
  netProfitCents: number;
  averageMargin: number;
  medianDaysToSale: number | null;
}

/** Which marketplace is actually working for this seller. */
export function computePlatformPerformance(
  sales: Sale[],
  items: Item[],
): PlatformPerformance[] {
  const byItem = new Map(items.map((i) => [i.id, i]));
  const groups = new Map<PlatformId, Sale[]>();

  for (const sale of sales) {
    if (!sale.confirmedAt) continue;
    const list = groups.get(sale.platform) ?? [];
    list.push(sale);
    groups.set(sale.platform, list);
  }

  const rows: PlatformPerformance[] = [];
  for (const [platform, group] of groups) {
    const gross = sum(group.map((s) => s.salePriceCents));
    const profit = sum(group.map((s) => s.profitCents));

    const durations = group
      .map((s) => {
        const item = byItem.get(s.itemId);
        if (!item?.listedAt || !s.confirmedAt) return null;
        const days = Math.floor(
          (new Date(s.confirmedAt).getTime() - new Date(item.listedAt).getTime()) / DAY_MS,
        );
        return Number.isFinite(days) && days >= 0 ? days : null;
      })
      .filter((d): d is number => d !== null)
      .sort((a, b) => a - b);

    rows.push({
      platform,
      salesCount: group.length,
      grossRevenueCents: gross,
      netProfitCents: profit,
      averageMargin: gross > 0 ? profit / gross : 0,
      medianDaysToSale: median(durations),
    });
  }

  return rows.sort((a, b) => b.netProfitCents - a.netProfitCents);
}

// ---------------------------------------------------------------------------
// Sourcing suggestions
// ---------------------------------------------------------------------------

export interface SourcingSuggestion {
  /** Brand, or category when the brand is unknown. */
  label: string;
  kind: 'brand' | 'category';
  salesCount: number;
  averageProfitCents: number;
  medianDaysToSale: number | null;
  /** Composite of margin and speed. Higher is a better thing to go buy more of. */
  score: number;
  reason: string;
}

/**
 * "What should I buy more of?" — answered from this seller's own history
 * rather than generic advice, which is the only version of this that is worth
 * anything.
 */
export function computeSourcingSuggestions(
  items: Item[],
  sales: Sale[],
  limit = 8,
): SourcingSuggestion[] {
  const byItem = new Map(items.map((i) => [i.id, i]));
  const buckets = new Map<string, { kind: 'brand' | 'category'; profits: number[]; days: number[] }>();

  for (const sale of sales) {
    if (!sale.confirmedAt) continue;
    const item = byItem.get(sale.itemId);
    if (!item?.attributes) continue;

    const brand = item.attributes.brand?.trim();
    const category = item.attributes.subcategory?.trim() ?? item.attributes.category?.trim();
    const key = brand ? `brand:${brand}` : category ? `category:${category}` : null;
    if (!key) continue;

    const bucket = buckets.get(key) ?? {
      kind: brand ? ('brand' as const) : ('category' as const),
      profits: [],
      days: [],
    };
    bucket.profits.push(sale.profitCents);

    if (item.listedAt) {
      const d = Math.floor(
        (new Date(sale.confirmedAt).getTime() - new Date(item.listedAt).getTime()) / DAY_MS,
      );
      if (Number.isFinite(d) && d >= 0) bucket.days.push(d);
    }
    buckets.set(key, bucket);
  }

  const suggestions: SourcingSuggestion[] = [];
  for (const [key, bucket] of buckets) {
    if (bucket.profits.length < 2) continue; // one sale is an anecdote, not a signal

    const avgProfit = Math.round(sum(bucket.profits) / bucket.profits.length);
    const medDays = median(bucket.days.sort((a, b) => a - b));

    // Reward profit, reward speed, and reward having actually happened more
    // than twice. A $60-margin item that takes a year is worse than a
    // $20-margin item that turns in a week.
    const speedFactor = medDays === null ? 0.5 : Math.max(0.15, 1 - medDays / 120);
    const volumeFactor = Math.min(1, bucket.profits.length / 5);
    const score = (avgProfit / 100) * speedFactor * (0.6 + 0.4 * volumeFactor);

    suggestions.push({
      label: key.slice(key.indexOf(':') + 1),
      kind: bucket.kind,
      salesCount: bucket.profits.length,
      averageProfitCents: avgProfit,
      medianDaysToSale: medDays,
      score: Number(score.toFixed(2)),
      reason:
        medDays === null
          ? `${bucket.profits.length} sales averaging $${(avgProfit / 100).toFixed(2)} profit.`
          : `${bucket.profits.length} sales, $${(avgProfit / 100).toFixed(2)} average profit, typically gone in ${medDays} days.`,
    });
  }

  return suggestions.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Tax export
// ---------------------------------------------------------------------------

export interface TaxSummary {
  year: number;
  grossReceiptsCents: number;
  costOfGoodsSoldCents: number;
  platformFeesCents: number;
  shippingCents: number;
  netIncomeCents: number;
  transactionCount: number;
  byPlatform: Array<{ platform: PlatformId; grossCents: number; feesCents: number; count: number }>;
}

/** Schedule C-shaped totals. Not tax advice; it is arithmetic on their own data. */
export function computeTaxSummary(sales: Sale[], year: number): TaxSummary {
  const inYear = sales.filter(
    (s) => s.confirmedAt && new Date(s.confirmedAt).getUTCFullYear() === year,
  );

  const byPlatform = new Map<PlatformId, { grossCents: number; feesCents: number; count: number }>();
  for (const sale of inYear) {
    const row = byPlatform.get(sale.platform) ?? { grossCents: 0, feesCents: 0, count: 0 };
    row.grossCents += sale.salePriceCents;
    row.feesCents += sale.feesCents;
    row.count += 1;
    byPlatform.set(sale.platform, row);
  }

  const grossReceiptsCents = sum(inYear.map((s) => s.salePriceCents));
  const costOfGoodsSoldCents = sum(inYear.map((s) => s.costBasisCents));
  const platformFeesCents = sum(inYear.map((s) => s.feesCents));
  const shippingCents = sum(inYear.map((s) => s.shippingCents));

  return {
    year,
    grossReceiptsCents,
    costOfGoodsSoldCents,
    platformFeesCents,
    shippingCents,
    netIncomeCents: grossReceiptsCents - costOfGoodsSoldCents - platformFeesCents - shippingCents,
    transactionCount: inYear.length,
    byPlatform: [...byPlatform.entries()].map(([platform, row]) => ({ platform, ...row })),
  };
}

// ---------------------------------------------------------------------------

function sum(values: number[]): number {
  return values.reduce((total, v) => total + v, 0);
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}
