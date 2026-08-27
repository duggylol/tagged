import type { Comp, PlatformId, PlatformListing } from '@tagged/core';

/**
 * The marketplace adapter interface.
 *
 * Every marketplace implements this, whether it is reached over an official
 * OAuth API (eBay, Etsy) or by the browser extension driving the seller's own
 * logged-in session (Poshmark, Mercari, Depop). The orchestration layer above
 * does not know or care which — that is what makes adding the sixth
 * marketplace a one-file job instead of an integration project.
 */

export interface AdapterCredentials {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  /** Anything platform-specific: eBay policy ids, Etsy shop id, and so on. */
  meta?: Record<string, string>;
}

export interface PublishInput {
  /** Tagged's own item id. Carried through so async callbacks can find it. */
  itemId: string;
  /** Stable per-item key. Also the marketplace SKU where one is required. */
  sku: string;
  listing: PlatformListing;
  /** Publicly reachable image URLs. Marketplaces fetch these themselves. */
  imageUrls: string[];
  /**
   * Same key = same intended effect, applied once. Without this a network
   * blip becomes a duplicate listing.
   */
  idempotencyKey: string;
}

export interface PublishResult {
  externalId: string;
  externalUrl: string | null;
  /** Non-fatal problems the seller should see. */
  warnings: string[];
}

export interface EndInput {
  externalId: string;
  idempotencyKey: string;
  reason: 'sold_elsewhere' | 'seller_withdrew';
}

export interface SoldItem {
  externalId: string;
  externalOrderId: string;
  salePriceCents: number;
  /** Fees, where the platform reports them. Null means fall back to our schedule. */
  feesCents: number | null;
  soldAt: string;
  buyerHandle: string | null;
}

export interface CompQuery {
  brand?: string;
  keywords: string[];
  category?: string;
  styleNumber?: string;
  limit?: number;
}

/**
 * Thrown when the seller needs to do something before this can work — the
 * token expired, the extension is not running, the app is not approved yet.
 * Distinct from a transient failure, because the UI response is different:
 * one is "reconnect your account", the other is "we'll retry".
 */
export class NotConnectedError extends Error {
  constructor(
    readonly platform: PlatformId,
    message: string,
    readonly action: 'reconnect' | 'install_extension' | 'open_browser' | 'awaiting_approval',
  ) {
    super(message);
    this.name = 'NotConnectedError';
  }
}

export class MarketplaceError extends Error {
  constructor(
    readonly platform: PlatformId,
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'MarketplaceError';
  }
}

export interface MarketplaceAdapter {
  readonly platform: PlatformId;

  /** Push a listing live. */
  publish(input: PublishInput, creds: AdapterCredentials): Promise<PublishResult>;

  /** Take a listing down. Must be idempotent — ending an ended listing is fine. */
  end(input: EndInput, creds: AdapterCredentials): Promise<void>;

  /** Change price without recreating the listing. */
  updatePrice(externalId: string, priceCents: number, creds: AdapterCredentials): Promise<void>;

  /** Anything sold since `since`. The sale-detection loop calls this. */
  fetchSold(since: Date, creds: AdapterCredentials): Promise<SoldItem[]>;

  /** Comparable listings for the pricing engine. Optional — most platforms cannot. */
  searchComps?(query: CompQuery, creds: AdapterCredentials): Promise<Comp[]>;
}

// ---------------------------------------------------------------------------

/** Words that are noise in a marketplace search box. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'with', 'for', 'in', 'on', 'of', 'size',
  'vintage', 'rare', 'nice', 'great', 'excellent', 'good', 'used', 'preowned',
]);

/**
 * Build a search string from a comp query. Kept here rather than in each
 * adapter so every platform searches consistently — otherwise the comp sets
 * are not comparable and the median is meaningless.
 */
export function buildSearchQuery(query: CompQuery): string {
  // A style number is an exact-match key. When we have one, nothing else helps.
  if (query.styleNumber && query.brand) {
    return `${query.brand} ${query.styleNumber}`;
  }

  const terms: string[] = [];
  if (query.brand) terms.push(query.brand);
  if (query.category) terms.push(query.category);

  for (const keyword of query.keywords) {
    const clean = keyword.trim().toLowerCase();
    if (!clean || STOP_WORDS.has(clean)) continue;
    if (terms.some((t) => t.toLowerCase() === clean)) continue;
    terms.push(keyword.trim());
    if (terms.length >= 6) break;
  }

  return terms.join(' ');
}

/** Marketplace prices arrive as strings in a dozen shapes. Normalize once. */
export function toCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Math.round(value * 100);
  const parsed = Number.parseFloat(value.replace(/[^0-9.]/g, ''));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}
