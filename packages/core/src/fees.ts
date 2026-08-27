import { getPlatform } from './platforms';
import type { NetProceeds, PlatformId } from './types';

export interface ProceedsInput {
  platform: PlatformId;
  salePriceCents: number;
  /** What the seller pays to ship. Zero when the buyer covers it. */
  shippingCostCents?: number;
  /** What the seller paid for the item. */
  costBasisCents?: number;
}

/**
 * What the seller actually keeps.
 *
 * Every competing tool shows gross sale price. Gross is a vanity number — a
 * $40 Poshmark sale nets less than a $32 eBay sale once the 20% commission
 * lands, and a seller who does not see that prices wrong on both platforms.
 */
export function calculateNetProceeds(input: ProceedsInput): NetProceeds {
  const { platform, salePriceCents } = input;
  const shippingCostCents = input.shippingCostCents ?? 0;
  const costBasisCents = input.costBasisCents ?? 0;
  const { fees } = getPlatform(platform);

  let marketplaceFeeCents: number;
  if (fees.flatFeeBelow && salePriceCents < fees.flatFeeBelow.thresholdCents) {
    marketplaceFeeCents = fees.flatFeeBelow.feeCents;
  } else {
    marketplaceFeeCents = Math.round(salePriceCents * fees.commissionRate);
  }

  const paymentFeeCents =
    fees.paymentRate > 0 || fees.paymentFixedCents > 0
      ? Math.round(salePriceCents * fees.paymentRate) + fees.paymentFixedCents
      : 0;

  const fixedFeeCents = fees.fixedCents + fees.listingFeeCents;

  const netRevenueCents =
    salePriceCents - marketplaceFeeCents - paymentFeeCents - fixedFeeCents - shippingCostCents;

  const profitCents = netRevenueCents - costBasisCents;

  return {
    platform,
    salePriceCents,
    marketplaceFeeCents,
    paymentFeeCents,
    fixedFeeCents,
    shippingCostCents,
    costBasisCents,
    netRevenueCents,
    profitCents,
    margin: salePriceCents > 0 ? profitCents / salePriceCents : 0,
  };
}

/**
 * The same item priced on every platform, sorted by what the seller keeps.
 * This is the view that answers "where should I actually sell this".
 */
export function compareAcrossPlatforms(
  platforms: PlatformId[],
  basePriceCents: number,
  opts: { shippingCostCents?: number; costBasisCents?: number } = {},
): NetProceeds[] {
  return platforms
    .map((platform) => {
      const spec = getPlatform(platform);
      // Each platform gets its own sticker price, then we compare the nets.
      const salePriceCents = Math.round(basePriceCents * spec.priceMultiplier);
      return calculateNetProceeds({ platform, salePriceCents, ...opts });
    })
    .sort((a, b) => b.profitCents - a.profitCents);
}

/**
 * The sale price needed to clear a target profit on a given platform.
 * Used by the pricing engine to enforce a minimum margin, and by the
 * sourcing scanner to answer "what can I pay for this?".
 */
export function priceForTargetProfit(
  platform: PlatformId,
  targetProfitCents: number,
  opts: { shippingCostCents?: number; costBasisCents?: number } = {},
): number {
  const shipping = opts.shippingCostCents ?? 0;
  const cost = opts.costBasisCents ?? 0;
  const { fees } = getPlatform(platform);

  // Solve for P:  P - P*commission - P*payment - fixed - shipping - cost = target
  const rate = fees.commissionRate + fees.paymentRate;
  const fixed = fees.fixedCents + fees.listingFeeCents + fees.paymentFixedCents;
  const numerator = targetProfitCents + fixed + shipping + cost;
  const price = numerator / (1 - rate);

  // Guard the flat-fee band: below the threshold the percentage does not apply,
  // so the solved price can land in a range where the real fee is different.
  if (fees.flatFeeBelow && price < fees.flatFeeBelow.thresholdCents) {
    return Math.ceil(targetProfitCents + fees.flatFeeBelow.feeCents + shipping + cost);
  }
  return Math.ceil(price);
}

/**
 * The most a seller can pay for an item and still hit their margin target.
 * The whole point of the in-store sourcing scanner.
 */
export function maxSourcingPrice(
  platform: PlatformId,
  expectedSalePriceCents: number,
  targetMargin: number,
  shippingCostCents = 0,
): number {
  const proceeds = calculateNetProceeds({
    platform,
    salePriceCents: expectedSalePriceCents,
    shippingCostCents,
  });
  const targetProfit = expectedSalePriceCents * targetMargin;
  return Math.max(0, Math.floor(proceeds.netRevenueCents - targetProfit));
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

export function parseDollars(input: string): number | null {
  const cleaned = input.replace(/[^0-9.-]/g, '');
  if (!cleaned) return null;
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}
