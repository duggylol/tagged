import type { ConnectionKind, PlatformId } from './types';

/**
 * Fee schedule for one marketplace.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ THESE NUMBERS GO STALE. Marketplaces change fee structures with weeks   │
 * │ of notice and no API to read them from. Every entry carries the date it │
 * │ was last checked and the page to check it against. Verify before you    │
 * │ show a seller a profit number, and re-verify quarterly.                 │
 * └─────────────────────────────────────────────────────────────────────────┘
 */
export interface FeeSchedule {
  /** Commission as a fraction of sale price, e.g. 0.1325 for 13.25%. */
  commissionRate: number;
  /** Flat per-order fee in cents, charged on top of commission. */
  fixedCents: number;
  /** Payment processing rate, where billed separately from commission. */
  paymentRate: number;
  /** Flat payment processing fee in cents. */
  paymentFixedCents: number;
  /** Per-listing fee in cents (Etsy charges this whether or not it sells). */
  listingFeeCents: number;
  /**
   * Some platforms use a flat fee below a threshold instead of a percentage.
   * Poshmark is the canonical example.
   */
  flatFeeBelow?: { thresholdCents: number; feeCents: number };
  lastVerified: string;
  verifyUrl: string;
}

export interface PlatformSpec {
  id: PlatformId;
  label: string;
  connection: ConnectionKind;
  /** False for platforms that are scaffolded but not wired up yet. */
  enabled: boolean;
  title: { maxChars: number };
  description: { maxChars: number; allowsHtml: boolean };
  tags: { max: number; maxCharsEach: number };
  /** Voice hint passed to the copy adapter. */
  tone: 'neutral' | 'casual' | 'boutique' | 'streetwear';
  /**
   * How much more than the market median this platform's buyers will bear on
   * the sticker. Poshmark buyers expect to negotiate down, so listing at the
   * median there leaves money on the table. Replace these hand-tuned
   * constants with a regression once you have a few thousand of your own
   * sales — see pricing.ts.
   */
  priceMultiplier: number;
  fees: FeeSchedule;
  notes: string;
}

export const PLATFORMS: Record<PlatformId, PlatformSpec> = {
  ebay: {
    id: 'ebay',
    label: 'eBay',
    connection: 'api',
    enabled: true,
    title: { maxChars: 80 },
    description: { maxChars: 500_000, allowsHtml: true },
    tags: { max: 0, maxCharsEach: 0 },
    tone: 'neutral',
    priceMultiplier: 1.0,
    fees: {
      commissionRate: 0.1325,
      fixedCents: 40,
      paymentRate: 0,
      paymentFixedCents: 0,
      listingFeeCents: 0,
      lastVerified: '2026-08-26',
      verifyUrl: 'https://www.ebay.com/help/selling/fees-credits-invoices/selling-fees',
    },
    notes:
      'Price-competitive search engine. Item specifics drive discovery far more than title keywords — fill every aspect the category offers.',
  },

  etsy: {
    id: 'etsy',
    label: 'Etsy',
    connection: 'api',
    enabled: true,
    title: { maxChars: 140 },
    description: { maxChars: 13_000, allowsHtml: false },
    tags: { max: 13, maxCharsEach: 20 },
    tone: 'boutique',
    priceMultiplier: 1.1,
    fees: {
      commissionRate: 0.065,
      fixedCents: 0,
      paymentRate: 0.03,
      paymentFixedCents: 25,
      listingFeeCents: 20,
      lastVerified: '2026-08-26',
      verifyUrl: 'https://help.etsy.com/hc/articles/360000343968',
    },
    notes:
      'Vintage only (20+ years) for secondhand clothing — listing modern used goods violates policy. Front-load the title; Etsy weights the first words most.',
  },

  poshmark: {
    id: 'poshmark',
    label: 'Poshmark',
    connection: 'extension',
    enabled: true,
    title: { maxChars: 50 },
    description: { maxChars: 1500, allowsHtml: false },
    tags: { max: 0, maxCharsEach: 0 },
    tone: 'casual',
    priceMultiplier: 1.25,
    fees: {
      commissionRate: 0.2,
      fixedCents: 0,
      paymentRate: 0,
      paymentFixedCents: 0,
      listingFeeCents: 0,
      flatFeeBelow: { thresholdCents: 1500, feeCents: 295 },
      lastVerified: '2026-08-26',
      verifyUrl: 'https://support.poshmark.com/s/article/What-are-the-fees',
    },
    notes:
      'Buyers expect to negotiate, so the sticker runs high and the floor does the real work. Sharing the closet drives more visibility than any listing copy.',
  },

  mercari: {
    id: 'mercari',
    label: 'Mercari',
    connection: 'extension',
    enabled: true,
    title: { maxChars: 40 },
    description: { maxChars: 1000, allowsHtml: false },
    tags: { max: 3, maxCharsEach: 20 },
    tone: 'neutral',
    priceMultiplier: 1.0,
    fees: {
      commissionRate: 0.1,
      fixedCents: 0,
      paymentRate: 0.029,
      paymentFixedCents: 50,
      listingFeeCents: 0,
      lastVerified: '2026-08-26',
      verifyUrl: 'https://www.mercari.com/help_center/article/197/',
    },
    notes:
      'Mercari has moved fees between buyer and seller more than once. Verify which side pays before trusting the profit number.',
  },

  depop: {
    id: 'depop',
    label: 'Depop',
    connection: 'extension',
    enabled: true,
    title: { maxChars: 65 },
    description: { maxChars: 1000, allowsHtml: false },
    tags: { max: 5, maxCharsEach: 20 },
    tone: 'streetwear',
    priceMultiplier: 1.15,
    fees: {
      commissionRate: 0,
      fixedCents: 0,
      paymentRate: 0.033,
      paymentFixedCents: 45,
      listingFeeCents: 0,
      lastVerified: '2026-08-26',
      verifyUrl: 'https://depophelp.zendesk.com/hc/en-gb/articles/360001791508',
    },
    notes:
      'Aesthetic-driven. Hashtags matter more than prose, and the register is lowercase and conversational. Also has a partner Selling API — apply for it; this extension path is the fallback.',
  },

  grailed: {
    id: 'grailed',
    label: 'Grailed',
    connection: 'extension',
    enabled: false,
    title: { maxChars: 60 },
    description: { maxChars: 1000, allowsHtml: false },
    tags: { max: 0, maxCharsEach: 0 },
    tone: 'streetwear',
    priceMultiplier: 1.2,
    fees: {
      commissionRate: 0.09,
      fixedCents: 0,
      paymentRate: 0.029,
      paymentFixedCents: 30,
      listingFeeCents: 0,
      lastVerified: '2026-08-26',
      verifyUrl: 'https://www.grailed.com/drycleanonly/selling-fees',
    },
    notes: 'Phase 6. Menswear, designer and archive focus. Brand accuracy is scrutinized hard by buyers.',
  },

  shopify: {
    id: 'shopify',
    label: 'Shopify',
    connection: 'api',
    enabled: false,
    title: { maxChars: 255 },
    description: { maxChars: 100_000, allowsHtml: true },
    tags: { max: 250, maxCharsEach: 255 },
    tone: 'boutique',
    priceMultiplier: 1.15,
    fees: {
      commissionRate: 0,
      fixedCents: 0,
      paymentRate: 0.029,
      paymentFixedCents: 30,
      listingFeeCents: 0,
      lastVerified: '2026-08-26',
      verifyUrl: 'https://www.shopify.com/pricing',
    },
    notes: 'Phase 6. No marketplace commission — the seller keeps everything but payment processing.',
  },
};

export const ALL_PLATFORMS = Object.values(PLATFORMS);

export const ENABLED_PLATFORMS = ALL_PLATFORMS.filter((p) => p.enabled);

export function getPlatform(id: PlatformId): PlatformSpec {
  const spec = PLATFORMS[id];
  if (!spec) throw new Error(`Unknown platform: ${id}`);
  return spec;
}

export function isPlatformId(value: string): value is PlatformId {
  return value in PLATFORMS;
}

/** Platforms reachable server-side, without the user's browser being open. */
export const API_PLATFORMS = ALL_PLATFORMS.filter((p) => p.connection === 'api');

/** Platforms that require the browser extension to be installed and running. */
export const EXTENSION_PLATFORMS = ALL_PLATFORMS.filter((p) => p.connection === 'extension');

/**
 * Below this, a listing must never auto-publish — the seller reviews first.
 * A wrong listing costs them a return, a refund, and a rating hit.
 */
export const MIN_PUBLISH_CONFIDENCE = 0.7;
