import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adaptListing,
  calculateNetProceeds,
  getPlatform,
  planDelist,
  planRelist,
  type PlatformId,
  type PlatformListing,
} from '@tagged/core';
import {
  getAdapter,
  NotConnectedError,
  PENDING_EXTERNAL_ID,
  skuForItem,
  type AdapterCredentials,
  type RegistryConfig,
} from '@tagged/marketplaces';

import { serverEnv } from './env';
import { toItem, toListing } from './mappers';
import { SupabaseExtensionQueue } from './queue';

/**
 * Publish, delist, confirm, relist.
 *
 * The ordering in `handleSaleDetected` is the single most important decision in
 * this file, and it is not the obvious one: listings come down from the other
 * marketplaces BEFORE the seller confirms anything. Waiting for confirmation
 * is precisely the window in which a double-sale happens. Ending a listing is
 * fully reversible; a cancellation strike is not.
 */

function registryConfig(supabase: SupabaseClient, userId: string): RegistryConfig {
  const env = serverEnv();
  return {
    userId,
    extensionQueue: new SupabaseExtensionQueue(supabase),
    ebay: env.ebay,
    etsy: env.etsy,
  };
}

async function credentialsFor(
  supabase: SupabaseClient,
  userId: string,
  platform: PlatformId,
): Promise<AdapterCredentials> {
  const { data } = await supabase
    .from('marketplace_accounts')
    .select('access_token, refresh_token, token_expires_at, meta, connected')
    .eq('user_id', userId)
    .eq('platform', platform)
    .maybeSingle();

  if (!data?.connected) {
    throw new NotConnectedError(platform, `${getPlatform(platform).label} is not connected.`, 'reconnect');
  }

  return {
    accessToken: (data.access_token as string) ?? undefined,
    refreshToken: (data.refresh_token as string) ?? undefined,
    expiresAt: (data.token_expires_at as string) ?? undefined,
    meta: (data.meta ?? {}) as Record<string, string>,
  };
}

/** Signed URLs the marketplace can fetch. Long-lived enough to survive a queue. */
async function imageUrlsFor(
  supabase: SupabaseClient,
  paths: string[],
): Promise<string[]> {
  if (paths.length === 0) return [];
  const { data } = await supabase.storage
    .from('item-photos')
    .createSignedUrls(paths.slice(0, 12), 60 * 60 * 24 * 7);

  return (data ?? [])
    .map((entry) => entry.signedUrl)
    .filter((url): url is string => typeof url === 'string' && url.length > 0);
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

export interface PublishOutcome {
  platform: PlatformId;
  ok: boolean;
  externalId?: string;
  externalUrl?: string | null;
  pending?: boolean;
  error?: string;
  warnings: string[];
}

export async function publishItem(
  supabase: SupabaseClient,
  userId: string,
  itemId: string,
  platforms: PlatformId[],
  priceOverrides: Partial<Record<PlatformId, number>> = {},
): Promise<PublishOutcome[]> {
  const { data: itemRow, error } = await supabase
    .from('items')
    .select('*')
    .eq('id', itemId)
    .single();

  if (error || !itemRow) throw new Error('Item not found.');
  const item = toItem(itemRow);

  if (!item.listingCore || !item.priceSuggestion) {
    throw new Error('This item has not been analysed yet. Run the AI pass first.');
  }

  const imageUrls = await imageUrlsFor(supabase, item.photoPaths);
  if (imageUrls.length === 0) {
    throw new Error('This item has no usable photos. Every marketplace requires at least one.');
  }

  const config = registryConfig(supabase, userId);
  const sku = skuForItem(itemId);
  const outcomes: PublishOutcome[] = [];

  for (const platform of platforms) {
    const listing: PlatformListing = adaptListing(platform, {
      core: item.listingCore,
      attributes: item.attributes,
      price: item.priceSuggestion,
      priceCentsOverride: priceOverrides[platform],
    });

    // Reserve the row first so a crash mid-publish leaves a visible
    // `publishing` state rather than a silent gap.
    await supabase.from('listings').upsert(
      {
        item_id: itemId,
        user_id: userId,
        platform,
        state: 'publishing',
        price_cents: listing.priceCents,
        payload_snapshot: listing,
        last_error: null,
      },
      { onConflict: 'item_id,platform' },
    );

    const idempotencyKey = `publish:${itemId}:${platform}:${listing.priceCents}`;

    await supabase.from('sync_events').insert({
      user_id: userId,
      item_id: itemId,
      platform,
      kind: 'listing.publish.requested',
      payload: { priceCents: listing.priceCents },
      idempotency_key: idempotencyKey,
    });

    try {
      const adapter = getAdapter(platform, config);
      const creds = await credentialsFor(supabase, userId, platform);
      const result = await adapter.publish({ itemId, sku, listing, imageUrls, idempotencyKey }, creds);

      const pending = result.externalId === PENDING_EXTERNAL_ID;

      await supabase
        .from('listings')
        .update({
          // Extension platforms stay in `publishing` until the extension
          // reports back with a real id.
          state: pending ? 'publishing' : 'active',
          external_id: pending ? null : result.externalId,
          external_url: result.externalUrl,
          published_at: pending ? null : new Date().toISOString(),
        })
        .eq('item_id', itemId)
        .eq('platform', platform);

      await supabase.from('sync_events').insert({
        user_id: userId,
        item_id: itemId,
        platform,
        kind: 'listing.publish.succeeded',
        payload: { externalId: result.externalId, pending },
      });

      outcomes.push({
        platform,
        ok: true,
        externalId: pending ? undefined : result.externalId,
        externalUrl: result.externalUrl,
        pending,
        warnings: result.warnings,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);

      await supabase
        .from('listings')
        .update({ state: 'error', last_error: message })
        .eq('item_id', itemId)
        .eq('platform', platform);

      await supabase.from('sync_events').insert({
        user_id: userId,
        item_id: itemId,
        platform,
        kind: 'listing.publish.failed',
        payload: { message },
      });

      outcomes.push({ platform, ok: false, error: message, warnings: listing.warnings });
    }
  }

  if (outcomes.some((o) => o.ok)) {
    await supabase
      .from('items')
      .update({ status: 'active', listed_at: item.listedAt ?? new Date().toISOString() })
      .eq('id', itemId);
  }

  return outcomes;
}

// ---------------------------------------------------------------------------
// Sale detected → delist everywhere else
// ---------------------------------------------------------------------------

export interface SaleDetectedInput {
  itemId: string;
  platform: PlatformId;
  salePriceCents: number;
  feesCents?: number | null;
  externalOrderId?: string;
  detectionSource: 'webhook' | 'poll' | 'extension' | 'email' | 'manual';
  soldAt?: string;
}

export async function handleSaleDetected(
  supabase: SupabaseClient,
  userId: string,
  input: SaleDetectedInput,
): Promise<{ delisted: PlatformId[]; skipped: Array<{ platform: PlatformId; reason: string }> }> {
  const saleRef = input.externalOrderId || `${input.itemId}:${input.soldAt ?? Date.now()}`;

  const { data: itemRow } = await supabase
    .from('items')
    .select('*')
    .eq('id', input.itemId)
    .single();
  if (!itemRow) throw new Error('Item not found.');
  const item = toItem(itemRow);

  // Already handled — sale detection runs from several sources at once
  // (webhook, poll, extension, email) and they will race by design.
  if (['sale_detected', 'delist_pending', 'awaiting_confirm', 'sold'].includes(item.status)) {
    return { delisted: [], skipped: [] };
  }

  await supabase
    .from('items')
    .update({ status: 'sale_detected' })
    .eq('id', input.itemId);

  await supabase.from('sync_events').insert({
    user_id: userId,
    item_id: input.itemId,
    platform: input.platform,
    kind: 'sale.detected',
    payload: { salePriceCents: input.salePriceCents, source: input.detectionSource },
    idempotency_key: `sale:${saleRef}`,
  });

  // Record the sale as UNCONFIRMED. Nothing is booked until the seller taps
  // confirm — exactly as specified.
  const fees =
    input.feesCents ??
    calculateNetProceeds({ platform: input.platform, salePriceCents: input.salePriceCents })
      .marketplaceFeeCents;

  await supabase.from('sales').insert({
    item_id: input.itemId,
    user_id: userId,
    platform: input.platform,
    sale_price_cents: input.salePriceCents,
    fees_cents: fees,
    cost_basis_cents: item.costBasisCents ?? 0,
    profit_cents: input.salePriceCents - fees - (item.costBasisCents ?? 0),
    external_order_id: input.externalOrderId ?? null,
    detection_source: input.detectionSource,
    detected_at: input.soldAt ?? new Date().toISOString(),
  });

  // Mark the selling listing sold.
  await supabase
    .from('listings')
    .update({ state: 'sold' })
    .eq('item_id', input.itemId)
    .eq('platform', input.platform);

  const { data: listingRows } = await supabase
    .from('listings')
    .select('*')
    .eq('item_id', input.itemId);

  const listings = (listingRows ?? []).map(toListing);
  const plan = planDelist(listings, input.platform, saleRef);

  await supabase
    .from('items')
    .update({ status: 'delist_pending' })
    .eq('id', input.itemId);

  const config = registryConfig(supabase, userId);
  const delisted: PlatformId[] = [];
  const skipped = [...plan.skipped];

  for (const action of plan.actions) {
    await supabase
      .from('listings')
      .update({ state: 'ending' })
      .eq('id', action.listingId);

    try {
      const adapter = getAdapter(action.platform, config);
      const creds = await credentialsFor(supabase, userId, action.platform).catch(() => ({}));

      await adapter.end(
        { externalId: action.externalId, idempotencyKey: action.idempotencyKey, reason: 'sold_elsewhere' },
        creds,
      );

      const spec = getPlatform(action.platform);
      await supabase
        .from('listings')
        .update({
          // Extension platforms only queued the request; the listing is not
          // actually down until the extension confirms.
          state: spec.connection === 'extension' ? 'ending' : 'ended',
          ended_at: spec.connection === 'extension' ? null : new Date().toISOString(),
        })
        .eq('id', action.listingId);

      await supabase.from('sync_events').insert({
        user_id: userId,
        item_id: input.itemId,
        platform: action.platform,
        kind: 'listing.end.succeeded',
        payload: { externalId: action.externalId },
      });

      delisted.push(action.platform);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await supabase
        .from('listings')
        .update({ state: 'error', last_error: message })
        .eq('id', action.listingId);

      await supabase.from('sync_events').insert({
        user_id: userId,
        item_id: input.itemId,
        platform: action.platform,
        kind: 'listing.end.failed',
        payload: { message },
      });

      skipped.push({ platform: action.platform, reason: message });
    }
  }

  await reconcileItemStatus(supabase, input.itemId);
  return { delisted, skipped };
}

/**
 * Move to `awaiting_confirm` once nothing is live anywhere else. Called after
 * delisting and again by the extension callback, because extension platforms
 * finish asynchronously.
 */
export async function reconcileItemStatus(
  supabase: SupabaseClient,
  itemId: string,
): Promise<void> {
  const { data: itemRow } = await supabase.from('items').select('status').eq('id', itemId).single();
  if (!itemRow) return;
  if (!['sale_detected', 'delist_pending'].includes(itemRow.status as string)) return;

  const { data: listingRows } = await supabase.from('listings').select('*').eq('item_id', itemId);
  const listings = (listingRows ?? []).map(toListing);

  const stillLive = listings.some(
    (l) => l.state === 'active' || l.state === 'publishing' || l.state === 'ending',
  );

  if (!stillLive) {
    await supabase.from('items').update({ status: 'awaiting_confirm' }).eq('id', itemId);
  }
}

// ---------------------------------------------------------------------------
// Confirm / cancel
// ---------------------------------------------------------------------------

export async function confirmSale(
  supabase: SupabaseClient,
  admin: SupabaseClient,
  userId: string,
  itemId: string,
  opts: { shippingCents?: number; costBasisCents?: number } = {},
): Promise<void> {
  const { data: saleRow } = await supabase
    .from('sales')
    .select('*')
    .eq('item_id', itemId)
    .is('confirmed_at', null)
    .order('detected_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!saleRow) throw new Error('No unconfirmed sale found for this item.');

  const { data: itemRow } = await supabase.from('items').select('*').eq('id', itemId).single();
  if (!itemRow) throw new Error('Item not found.');
  const item = toItem(itemRow);

  const costBasis = opts.costBasisCents ?? item.costBasisCents ?? 0;
  const shipping = opts.shippingCents ?? 0;

  const proceeds = calculateNetProceeds({
    platform: saleRow.platform as PlatformId,
    salePriceCents: saleRow.sale_price_cents as number,
    shippingCostCents: shipping,
    costBasisCents: costBasis,
  });

  const now = new Date().toISOString();

  await supabase
    .from('sales')
    .update({
      confirmed_at: now,
      fees_cents: proceeds.marketplaceFeeCents + proceeds.paymentFeeCents + proceeds.fixedFeeCents,
      shipping_cents: shipping,
      cost_basis_cents: costBasis,
      profit_cents: proceeds.profitCents,
    })
    .eq('id', saleRow.id);

  await supabase
    .from('items')
    .update({ status: 'sold', sold_at: now, cost_basis_cents: costBasis })
    .eq('id', itemId);

  await supabase.from('sync_events').insert({
    user_id: userId,
    item_id: itemId,
    platform: saleRow.platform,
    kind: 'sale.confirmed',
    payload: { profitCents: proceeds.profitCents },
  });

  // Contribute to the pooled comp set. Anonymized — nothing here identifies
  // who sold it. This table is why the pricing engine gets better every week
  // even though eBay's sold-comp API is closed to us.
  const daysToSale =
    item.listedAt !== null
      ? Math.max(
          0,
          Math.round((new Date(now).getTime() - new Date(item.listedAt).getTime()) / 86_400_000),
        )
      : null;

  await admin.from('comps').insert({
    platform: saleRow.platform,
    brand: item.attributes?.brand ?? null,
    category: item.attributes?.category ?? null,
    subcategory: item.attributes?.subcategory ?? null,
    size_normalized: item.attributes?.sizeNormalized ?? null,
    condition: item.attributes?.condition ?? null,
    price_cents: saleRow.sale_price_cents,
    days_to_sale: daysToSale,
    title: item.title,
  });
}

export async function cancelSaleAndRelist(
  supabase: SupabaseClient,
  userId: string,
  itemId: string,
): Promise<{ relisted: PlatformId[]; skipped: Array<{ platform: PlatformId; reason: string }> }> {
  const now = new Date().toISOString();

  await supabase
    .from('sales')
    .update({ cancelled_at: now })
    .eq('item_id', itemId)
    .is('confirmed_at', null);

  await supabase.from('items').update({ status: 'relisting' }).eq('id', itemId);

  await supabase.from('sync_events').insert({
    user_id: userId,
    item_id: itemId,
    kind: 'sale.cancelled',
    payload: {},
  });

  return relistItem(supabase, userId, itemId);
}

/**
 * Put everything back from the stored payload snapshots. This is the payoff
 * for saving them on the way down — a cancelled sale costs one tap rather
 * than re-entering the whole listing.
 */
export async function relistItem(
  supabase: SupabaseClient,
  userId: string,
  itemId: string,
): Promise<{ relisted: PlatformId[]; skipped: Array<{ platform: PlatformId; reason: string }> }> {
  const { data: listingRows } = await supabase.from('listings').select('*').eq('item_id', itemId);
  const listings = (listingRows ?? []).map(toListing);

  const relistRef = `${itemId}:${Date.now()}`;
  const plan = planRelist(listings, relistRef);

  await supabase.from('sync_events').insert({
    user_id: userId,
    item_id: itemId,
    kind: 'item.relist.requested',
    payload: { platforms: plan.actions.map((a) => a.platform) },
  });

  const { data: itemRow } = await supabase.from('items').select('photo_paths').eq('id', itemId).single();
  const imageUrls = await imageUrlsFor(supabase, (itemRow?.photo_paths as string[]) ?? []);

  const config = registryConfig(supabase, userId);
  const sku = skuForItem(itemId);
  const relisted: PlatformId[] = [];
  const skipped = [...plan.skipped];

  for (const action of plan.actions) {
    const listing = listings.find((l) => l.id === action.listingId);
    if (!listing?.payloadSnapshot) continue;

    try {
      const adapter = getAdapter(action.platform, config);
      const creds = await credentialsFor(supabase, userId, action.platform);
      const result = await adapter.publish(
        { itemId, sku, listing: listing.payloadSnapshot, imageUrls, idempotencyKey: action.idempotencyKey },
        creds,
      );

      const pending = result.externalId === PENDING_EXTERNAL_ID;
      await supabase
        .from('listings')
        .update({
          state: pending ? 'publishing' : 'active',
          external_id: pending ? null : result.externalId,
          external_url: result.externalUrl,
          ended_at: null,
          last_error: null,
        })
        .eq('id', action.listingId);

      relisted.push(action.platform);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await supabase
        .from('listings')
        .update({ state: 'error', last_error: message })
        .eq('id', action.listingId);
      skipped.push({ platform: action.platform, reason: message });
    }
  }

  await supabase
    .from('items')
    .update({ status: relisted.length > 0 ? 'active' : 'draft', sold_at: null })
    .eq('id', itemId);

  return { relisted, skipped };
}
