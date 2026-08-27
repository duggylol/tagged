import type {
  CapturePhoto,
  CaptureSession,
  Item,
  Listing,
  MarketplaceAccount,
  Sale,
} from '@tagged/core';

/**
 * The snake_case ↔ camelCase boundary, in exactly one place.
 *
 * Postgres wants snake_case; the domain types in @tagged/core are camelCase
 * because they also compile into a native app where nobody is thinking about
 * SQL. Rather than scattering `row.cost_basis_cents` through the UI, every row
 * crosses the boundary here.
 */

type Row = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const nstr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const nnum = (v: unknown): number | null => (typeof v === 'number' ? v : null);

export function toItem(row: Row): Item {
  return {
    id: str(row['id']),
    userId: str(row['user_id']),
    status: row['status'] as Item['status'],
    analysisStatus: row['analysis_status'] as Item['analysisStatus'],
    title: nstr(row['title']),
    attributes: (row['attributes'] as Item['attributes']) ?? null,
    listingCore: (row['listing_core'] as Item['listingCore']) ?? null,
    priceSuggestion: (row['price_suggestion'] as Item['priceSuggestion']) ?? null,
    costBasisCents: nnum(row['cost_basis_cents']),
    sourceNote: nstr(row['source_note']),
    photoPaths: Array.isArray(row['photo_paths']) ? (row['photo_paths'] as string[]) : [],
    phash: nstr(row['phash']),
    createdAt: str(row['created_at']),
    updatedAt: str(row['updated_at']),
    listedAt: nstr(row['listed_at']),
    soldAt: nstr(row['sold_at']),
  };
}

export function toListing(row: Row): Listing {
  return {
    id: str(row['id']),
    itemId: str(row['item_id']),
    userId: str(row['user_id']),
    platform: row['platform'] as Listing['platform'],
    state: row['state'] as Listing['state'],
    externalId: nstr(row['external_id']),
    externalUrl: nstr(row['external_url']),
    priceCents: nnum(row['price_cents']),
    payloadSnapshot: (row['payload_snapshot'] as Listing['payloadSnapshot']) ?? null,
    lastError: nstr(row['last_error']),
    publishedAt: nstr(row['published_at']),
    endedAt: nstr(row['ended_at']),
  };
}

export function toCapturePhoto(row: Row): CapturePhoto {
  return {
    id: str(row['id']),
    sessionId: str(row['session_id']),
    userId: str(row['user_id']),
    itemId: nstr(row['item_id']),
    storagePath: str(row['storage_path']),
    phash: nstr(row['phash']),
    width: nnum(row['width']),
    height: nnum(row['height']),
    sequence: typeof row['sequence'] === 'number' ? row['sequence'] : 0,
    role: (row['role'] as CapturePhoto['role']) ?? 'unspecified',
    createdAt: str(row['created_at']),
  };
}

export function toCaptureSession(row: Row): CaptureSession {
  return {
    id: str(row['id']),
    userId: str(row['user_id']),
    code: str(row['code']),
    status: row['status'] as CaptureSession['status'],
    hostLabel: nstr(row['host_label']),
    guestLabel: nstr(row['guest_label']),
    currentItemId: nstr(row['current_item_id']),
    createdAt: str(row['created_at']),
    expiresAt: str(row['expires_at']),
  };
}

export function toSale(row: Row): Sale {
  return {
    id: str(row['id']),
    itemId: str(row['item_id']),
    userId: str(row['user_id']),
    platform: row['platform'] as Sale['platform'],
    salePriceCents: typeof row['sale_price_cents'] === 'number' ? row['sale_price_cents'] : 0,
    feesCents: typeof row['fees_cents'] === 'number' ? row['fees_cents'] : 0,
    shippingCents: typeof row['shipping_cents'] === 'number' ? row['shipping_cents'] : 0,
    costBasisCents: typeof row['cost_basis_cents'] === 'number' ? row['cost_basis_cents'] : 0,
    profitCents: typeof row['profit_cents'] === 'number' ? row['profit_cents'] : 0,
    detectedAt: str(row['detected_at']),
    confirmedAt: nstr(row['confirmed_at']),
    detectionSource: row['detection_source'] as Sale['detectionSource'],
  };
}

export function toAccount(row: Row): MarketplaceAccount {
  return {
    id: str(row['id']),
    userId: str(row['user_id']),
    platform: row['platform'] as MarketplaceAccount['platform'],
    connectionKind: row['connection_kind'] as MarketplaceAccount['connectionKind'],
    externalUsername: nstr(row['external_username']),
    connected: row['connected'] === true,
    tokenExpiresAt: nstr(row['token_expires_at']),
    lastSeenAt: nstr(row['last_seen_at']),
    scopes: Array.isArray(row['scopes']) ? (row['scopes'] as string[]) : [],
  };
}
