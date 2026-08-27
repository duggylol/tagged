/**
 * Domain types for Tagged.
 *
 * This module is deliberately free of any runtime dependency — no Node, no
 * DOM, no framework. Everything here compiles unchanged for web, for a
 * Capacitor iOS/Android bundle, and for an edge worker.
 */

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

export type PlatformId =
  | 'ebay'
  | 'etsy'
  | 'poshmark'
  | 'mercari'
  | 'depop'
  | 'grailed'
  | 'shopify';

/** How Tagged actually reaches a marketplace. */
export type ConnectionKind =
  /** Official OAuth API. Server-to-server, works while the user is offline. */
  | 'api'
  /** Browser extension driving the user's own logged-in session. */
  | 'extension';

// ---------------------------------------------------------------------------
// Item lifecycle
// ---------------------------------------------------------------------------

/**
 * The master state of a physical piece of inventory.
 *
 * An item is never hard-deleted. `sold` and `archived` are terminal for
 * everyday purposes but both can be reopened if a sale falls through.
 */
export type ItemStatus =
  /** Created, not yet listed anywhere. May still be mid-analysis. */
  | 'draft'
  /** Live on at least one marketplace. */
  | 'active'
  /** A sale was detected on one platform; delisting elsewhere is queued. */
  | 'sale_detected'
  /** Delist calls are in flight to the other platforms. */
  | 'delist_pending'
  /** Delisted everywhere. Waiting for the seller to confirm the sale is real. */
  | 'awaiting_confirm'
  /** Seller confirmed. Profit booked. */
  | 'sold'
  /** Sale fell through; listings are being restored from snapshot. */
  | 'relisting'
  /** Withdrawn from sale by the seller. */
  | 'archived';

/** Where an item sits in the AI pipeline. Orthogonal to {@link ItemStatus}. */
export type AnalysisStatus =
  | 'pending'
  | 'extracting'
  | 'resolving'
  | 'pricing'
  | 'writing'
  | 'complete'
  | 'failed';

/** Per-platform listing state. One row per item per platform. */
export type ListingState =
  | 'not_listed'
  | 'publishing'
  | 'active'
  | 'ending'
  | 'ended'
  | 'sold'
  | 'error';

export type ItemCondition =
  | 'new_with_tags'
  | 'new_without_tags'
  | 'excellent'
  | 'good'
  | 'fair'
  | 'poor';

// ---------------------------------------------------------------------------
// Extracted attributes — the Stage 1 model output
// ---------------------------------------------------------------------------

export interface Measurement {
  /** e.g. "pit_to_pit", "length", "inseam", "waist" */
  key: string;
  inches: number;
  /** How the number was obtained. */
  source: 'estimated' | 'reference_object' | 'manual';
}

export interface Defect {
  kind: 'stain' | 'hole' | 'tear' | 'pilling' | 'fading' | 'missing_part' | 'odor' | 'other';
  /** Where on the garment, in plain language. */
  location: string;
  severity: 'minor' | 'moderate' | 'significant';
  /** A ready-to-paste disclosure sentence. */
  disclosure: string;
}

/**
 * Everything the vision model reads off the photos. Every field is optional
 * because a crumpled care tag genuinely does not always yield a brand, and
 * pretending otherwise produces confidently wrong listings.
 */
export interface ExtractedAttributes {
  brand?: string;
  /** Sub-line or collaboration, e.g. "Nike ACG", "Levi's Silver Tab". */
  line?: string;
  /** As printed on the tag: "M", "32x34", "8", "One Size". */
  size?: string;
  /** Normalized for filtering: "s" | "m" | "l" | "xl" | numeric string. */
  sizeNormalized?: string;
  category?: string;
  subcategory?: string;
  /** Menswear / womenswear / kids / unisex, as the tag or cut suggests. */
  department?: string;
  colors: string[];
  pattern?: string;
  /** Fabric content, e.g. "100% cotton" or "60% cotton / 40% poly". */
  material?: string;
  /** Style keywords for search: "y2k", "gorpcore", "workwear". */
  styleKeywords: string[];
  /** Decade or era cue read from label design, e.g. "1990s". */
  era?: string;
  /** Style / SKU number printed on the care tag. Highest-value lookup key. */
  styleNumber?: string;
  /** FTC Registered Number — resolves to a manufacturer via the public registry. */
  rnNumber?: string;
  countryOfOrigin?: string;
  condition?: ItemCondition;
  defects: Defect[];
  measurements: Measurement[];
  /** 0..1. Below `MIN_PUBLISH_CONFIDENCE` the listing must not auto-publish. */
  confidence: number;
  /** Model's own account of what it was unsure about. Shown to the seller. */
  uncertainNotes: string[];
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/** One observed data point about what something like this goes for. */
export interface Comp {
  source: 'internal_sold' | 'ebay_active' | 'user_history' | 'manual';
  platform?: PlatformId;
  priceCents: number;
  /** Present only for sold comps. */
  daysToSale?: number;
  /** 0..1 — how close this comp is to the item being priced. */
  similarity: number;
  observedAt: string;
  title?: string;
  url?: string;
}

export interface PriceSuggestion {
  /** What to put on the sticker. */
  listPriceCents: number;
  /** Lowest offer to auto-accept. */
  floorPriceCents: number;
  /** Middle of the comp set — the honest "what it's worth". */
  medianCents: number;
  /** Interquartile range, as a signal of how noisy the comp set is. */
  p25Cents: number;
  p75Cents: number;
  sampleSize: number;
  /** 0..1. Low means "we guessed"; surface that to the seller. */
  confidence: number;
  expectedDaysToSale?: number;
  /** Human-readable account of how the number was reached. */
  rationale: string;
}

/** What the seller actually keeps, after everyone takes their cut. */
export interface NetProceeds {
  platform: PlatformId;
  salePriceCents: number;
  /** Marketplace commission. */
  marketplaceFeeCents: number;
  /** Payment processing, where charged separately. */
  paymentFeeCents: number;
  /** Per-listing or per-order flat fees. */
  fixedFeeCents: number;
  /** Seller-paid shipping. Zero when the buyer pays. */
  shippingCostCents: number;
  /** What the seller paid to acquire the item. */
  costBasisCents: number;
  /** salePrice - all fees - shipping. Before cost basis. */
  netRevenueCents: number;
  /** netRevenue - costBasis. The number that matters. */
  profitCents: number;
  /** profit / salePrice, 0..1. */
  margin: number;
}

// ---------------------------------------------------------------------------
// Listing content
// ---------------------------------------------------------------------------

/**
 * The platform-neutral listing produced by one model call. Everything
 * downstream is deterministic code shaping this to each marketplace.
 */
export interface ListingCore {
  /** Ordered most- to least-important. Adapters truncate from the end. */
  titleTokens: string[];
  /** Fallback single-line title if tokens are unusable. */
  title: string;
  /** Short scannable selling points. */
  bullets: string[];
  /** Body copy, plain text with newlines. No HTML. */
  description: string;
  /** Ranked search keywords. Adapters take as many as the platform allows. */
  keywords: string[];
  /** Sentences the seller is legally or reputationally better off including. */
  disclosures: string[];
}

/** A listing shaped for one specific marketplace. */
export interface PlatformListing {
  platform: PlatformId;
  title: string;
  description: string;
  tags: string[];
  priceCents: number;
  /** Platform-specific structured fields (eBay item specifics, Etsy attributes). */
  attributes: Record<string, string>;
  /** Non-fatal problems, e.g. "title truncated", "no size tag on this platform". */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Persisted records
// ---------------------------------------------------------------------------

export interface Item {
  id: string;
  userId: string;
  status: ItemStatus;
  analysisStatus: AnalysisStatus;
  title: string | null;
  attributes: ExtractedAttributes | null;
  listingCore: ListingCore | null;
  priceSuggestion: PriceSuggestion | null;
  /** What the seller paid. Null until they enter it. */
  costBasisCents: number | null;
  sourceNote: string | null;
  photoPaths: string[];
  /** Perceptual hash of the primary photo — used for duplicate detection. */
  phash: string | null;
  createdAt: string;
  updatedAt: string;
  listedAt: string | null;
  soldAt: string | null;
}

export interface Listing {
  id: string;
  itemId: string;
  userId: string;
  platform: PlatformId;
  state: ListingState;
  externalId: string | null;
  externalUrl: string | null;
  priceCents: number | null;
  /**
   * The exact payload last sent to the marketplace. This is what makes
   * one-tap relist possible after a cancelled sale — without it the seller
   * re-enters everything by hand.
   */
  payloadSnapshot: PlatformListing | null;
  lastError: string | null;
  publishedAt: string | null;
  endedAt: string | null;
}

export type SyncEventKind =
  | 'listing.publish.requested'
  | 'listing.publish.succeeded'
  | 'listing.publish.failed'
  | 'listing.end.requested'
  | 'listing.end.succeeded'
  | 'listing.end.failed'
  | 'sale.detected'
  | 'sale.confirmed'
  | 'sale.cancelled'
  | 'item.relist.requested'
  | 'analysis.started'
  | 'analysis.completed'
  | 'analysis.failed';

export interface SyncEvent {
  id: string;
  userId: string;
  itemId: string | null;
  platform: PlatformId | null;
  kind: SyncEventKind;
  payload: Record<string, unknown>;
  /** Deduplicates retries. Same key = same intended effect, applied once. */
  idempotencyKey: string | null;
  createdAt: string;
}

export interface Sale {
  id: string;
  itemId: string;
  userId: string;
  platform: PlatformId;
  salePriceCents: number;
  feesCents: number;
  shippingCents: number;
  costBasisCents: number;
  profitCents: number;
  detectedAt: string;
  confirmedAt: string | null;
  /** How Tagged found out. Useful for tuning detection. */
  detectionSource: 'webhook' | 'poll' | 'extension' | 'email' | 'manual';
}

// ---------------------------------------------------------------------------
// Phone ↔ PC capture pairing
// ---------------------------------------------------------------------------

export type CaptureSessionStatus = 'waiting' | 'paired' | 'closed' | 'expired';

/**
 * A short-lived channel between a desktop browser and a phone. The desktop
 * opens it and renders a QR; the phone scans and starts pushing photos.
 */
export interface CaptureSession {
  id: string;
  userId: string;
  /** Six characters, unambiguous alphabet. Shown under the QR to type by hand. */
  code: string;
  status: CaptureSessionStatus;
  /** Human label for the desktop that opened it, e.g. "Chrome on Windows". */
  hostLabel: string | null;
  /** Human label for the phone that joined. */
  guestLabel: string | null;
  /** The item currently being photographed. Rotates as the phone taps "Next item". */
  currentItemId: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface CapturePhoto {
  id: string;
  sessionId: string;
  userId: string;
  itemId: string | null;
  storagePath: string;
  /** Client-computed, so the desktop can dedupe and group without downloading. */
  phash: string | null;
  width: number | null;
  height: number | null;
  /** Ordering within the session. */
  sequence: number;
  /** Set by the phone: "this shot is the care tag" materially improves extraction. */
  role: PhotoRole;
  createdAt: string;
}

export type PhotoRole = 'front' | 'back' | 'tag' | 'detail' | 'defect' | 'unspecified';

// ---------------------------------------------------------------------------
// Marketplace accounts
// ---------------------------------------------------------------------------

export interface MarketplaceAccount {
  id: string;
  userId: string;
  platform: PlatformId;
  connectionKind: ConnectionKind;
  /** Display handle on that marketplace. */
  externalUsername: string | null;
  /** True when we hold a usable token (api) or saw a live session (extension). */
  connected: boolean;
  /** Only ever set for `api` connections. Encrypted at rest by Postgres. */
  tokenExpiresAt: string | null;
  lastSeenAt: string | null;
  scopes: string[];
}
