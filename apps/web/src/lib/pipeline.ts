import type { SupabaseClient } from '@supabase/supabase-js';
import {
  BudgetExceededError,
  RoutedProvider,
  withRetry,
  type ImageInput,
  type Usage,
} from '@tagged/ai';
import {
  defaultTitleTokens,
  selectPhotosForAnalysis,
  suggestPrice,
  type Comp,
  type ExtractedAttributes,
  type ListingCore,
  type PlatformId,
  type PriceSuggestion,
} from '@tagged/core';
import { EbayAdapter } from '@tagged/marketplaces';

import { serverEnv } from './env';
import { toCapturePhoto } from './mappers';

/**
 * The analysis pipeline.
 *
 * Stage 0 already happened in the browser (downscale, WebP, perceptual hash),
 * which is why the images arriving here are ~120KB rather than 4MB. What runs
 * server-side is two model calls with a lot of free code between them:
 *
 *   1. extract   — one vision call into a strict schema        (~$0.0005)
 *   2. resolve   — vector search + eBay Browse, no model       ($0)
 *   3. price     — statistics over the comp set, no model      ($0)
 *   4. write     — one copy call                               (~$0.0005)
 *
 * About a tenth of a cent per item. The AI is not what makes this expensive.
 */

export interface PipelineResult {
  attributes: ExtractedAttributes;
  priceSuggestion: PriceSuggestion;
  listingCore: ListingCore;
  compsFound: number;
  totalCostUsd: number;
}

type Stage = 'extracting' | 'resolving' | 'pricing' | 'writing' | 'complete' | 'failed';

export class PipelineError extends Error {
  constructor(message: string, readonly stage: Stage, readonly cause?: unknown) {
    super(message);
    this.name = 'PipelineError';
  }
}

export async function runPipeline(
  supabase: SupabaseClient,
  admin: SupabaseClient,
  userId: string,
  itemId: string,
): Promise<PipelineResult> {
  const env = serverEnv();
  const usages: Usage[] = [];

  const setStage = async (stage: Stage, error?: string) => {
    await supabase
      .from('items')
      .update({ analysis_status: stage, analysis_error: error ?? null })
      .eq('id', itemId);
  };

  try {
    await assertWithinBudget(supabase, userId, env.monthlyBudgetUsd);

    const { data: item, error: itemError } = await supabase
      .from('items')
      .select('id, photo_paths, seller_notes, cost_basis_cents')
      .eq('id', itemId)
      .single();

    if (itemError || !item) {
      throw new PipelineError('Item not found.', 'failed', itemError);
    }
    if (!item.photo_paths?.length) {
      throw new PipelineError('This item has no photos yet.', 'failed');
    }

    const provider = new RoutedProvider({
      geminiApiKey: env.geminiApiKey,
      anthropicApiKey: env.anthropicApiKey,
      visionProvider: env.visionProvider,
      copyProvider: env.copyProvider,
      visionModel: env.visionModel,
      copyModel: env.copyModel,
      premiumCopyModel: env.premiumCopyModel,
    });

    // --- Stage 1: extract ---------------------------------------------------
    await setStage('extracting');

    const images = await loadImages(supabase, userId, itemId, item.photo_paths);
    const extraction = await withRetry(() =>
      provider.extractAttributes({
        images,
        sellerNotes: item.seller_notes ?? undefined,
      }),
    );
    usages.push(extraction.usage);
    const attributes = extraction.attributes;

    // --- Stage 2: resolve ---------------------------------------------------
    await setStage('resolving');
    const comps = await gatherComps(supabase, admin, userId, attributes);

    // --- Stage 3: price -----------------------------------------------------
    await setStage('pricing');
    const priceSuggestion = suggestPrice(comps, {
      // Never suggest below what they paid plus a token margin.
      minPriceCents: item.cost_basis_cents ? Math.round(item.cost_basis_cents * 1.5) : 500,
    });

    // --- Stage 4: write -----------------------------------------------------
    await setStage('writing');
    const targetPlatforms = await connectedPlatforms(supabase, userId);
    const written = await withRetry(() =>
      provider.writeListing({
        attributes,
        compTitles: comps
          .filter((c) => c.title)
          .slice(0, 8)
          .map((c) => c.title!),
        targetPlatforms,
        sellerNotes: item.seller_notes ?? undefined,
      }),
    );
    usages.push(written.usage);

    const listingCore = written.core;
    if (listingCore.titleTokens.length === 0) {
      listingCore.titleTokens = defaultTitleTokens(attributes);
    }

    // --- Persist ------------------------------------------------------------
    const title = listingCore.titleTokens.slice(0, 6).join(' ').slice(0, 120);

    await supabase
      .from('items')
      .update({
        attributes,
        listing_core: listingCore,
        price_suggestion: priceSuggestion,
        title,
        analysis_status: 'complete',
        analysis_error: null,
      })
      .eq('id', itemId);

    await recordUsage(supabase, userId, itemId, usages);

    await supabase.from('sync_events').insert({
      user_id: userId,
      item_id: itemId,
      kind: 'analysis.completed',
      payload: {
        confidence: attributes.confidence,
        compsFound: comps.length,
        costUsd: totalCost(usages),
      },
    });

    return {
      attributes,
      priceSuggestion,
      listingCore,
      compsFound: comps.length,
      totalCostUsd: totalCost(usages),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Analysis failed.';
    await setStage('failed', message);

    // Bill for whatever actually ran before the failure.
    if (usages.length > 0) await recordUsage(supabase, userId, itemId, usages);

    await supabase.from('sync_events').insert({
      user_id: userId,
      item_id: itemId,
      kind: 'analysis.failed',
      payload: { message },
    });

    throw error instanceof PipelineError
      ? error
      : new PipelineError(message, 'failed', error);
  }
}

// ---------------------------------------------------------------------------
// Stage helpers
// ---------------------------------------------------------------------------

/**
 * Pull the photos and pick which ones to actually send.
 *
 * Sending every shot is wasteful — most are near-duplicates. Four well-chosen
 * frames cost about a twentieth of a cent and outperform twelve, and the care
 * tag is the highest-signal frame in the whole app.
 */
async function loadImages(
  supabase: SupabaseClient,
  userId: string,
  itemId: string,
  paths: string[],
): Promise<ImageInput[]> {
  const { data: photoRows } = await supabase
    .from('capture_photos')
    .select('id, storage_path, role, sequence, item_id, session_id, user_id, phash, width, height, created_at')
    .eq('item_id', itemId)
    .order('sequence');

  // Prefer role-aware selection when the photos came through a capture
  // session; fall back to plain paths for photos uploaded straight from the
  // desktop, which have no role metadata.
  const chosenPaths =
    photoRows && photoRows.length > 0
      ? selectPhotosForAnalysis(photoRows.map(toCapturePhoto)).map((p) => ({
          path: p.storagePath,
          role: p.role as string,
        }))
      : paths.slice(0, 4).map((path) => ({ path, role: 'unspecified' }));

  const images: ImageInput[] = [];

  for (const { path, role } of chosenPaths) {
    if (!path) continue;
    const { data, error } = await supabase.storage.from('item-photos').download(path);
    if (error || !data) continue;

    const buffer = await data.arrayBuffer();
    images.push({
      mimeType: data.type || 'image/webp',
      data: toBase64(buffer),
      role,
    });
  }

  if (images.length === 0) {
    throw new PipelineError('Could not read any of this item\'s photos from storage.', 'extracting');
  }
  void userId;
  return images;
}

/**
 * Build the comp set.
 *
 * Order matters and reflects data quality: our own confirmed sales first
 * (free, exact, and improving daily), then eBay's active listings (an asking
 * price, not a sale — weighted down accordingly by the pricing engine).
 */
async function gatherComps(
  supabase: SupabaseClient,
  admin: SupabaseClient,
  userId: string,
  attributes: ExtractedAttributes,
): Promise<Comp[]> {
  const comps: Comp[] = [];

  // --- Our own pooled sold data ---
  if (attributes.brand || attributes.category) {
    let query = admin
      .from('comps')
      .select('platform, price_cents, days_to_sale, title, observed_at, brand, category, size_normalized')
      .order('observed_at', { ascending: false })
      .limit(40);

    if (attributes.brand) query = query.ilike('brand', attributes.brand);
    else if (attributes.category) query = query.ilike('category', attributes.category);

    const { data } = await query;
    for (const row of data ?? []) {
      comps.push({
        source: 'internal_sold',
        platform: row.platform as PlatformId,
        priceCents: row.price_cents,
        daysToSale: row.days_to_sale ?? undefined,
        similarity: scoreInternalComp(attributes, row),
        observedAt: row.observed_at,
        title: row.title ?? undefined,
      });
    }
  }

  // --- This seller's own history ---
  const { data: ownSales } = await supabase
    .from('sales')
    .select('platform, sale_price_cents, confirmed_at, items!inner(attributes)')
    .not('confirmed_at', 'is', null)
    .order('confirmed_at', { ascending: false })
    .limit(20);

  for (const sale of ownSales ?? []) {
    const saleAttrs = (sale as unknown as { items: { attributes: ExtractedAttributes | null } })
      .items?.attributes;
    if (!saleAttrs) continue;
    if (attributes.brand && saleAttrs.brand?.toLowerCase() !== attributes.brand.toLowerCase()) continue;

    comps.push({
      source: 'user_history',
      platform: sale.platform as PlatformId,
      priceCents: sale.sale_price_cents,
      similarity: 0.85,
      observedAt: sale.confirmed_at,
    });
  }

  // --- eBay active listings ---
  const env = serverEnv();
  if (env.ebay) {
    const { data: account } = await supabase
      .from('marketplace_accounts')
      .select('access_token, token_expires_at, meta')
      .eq('platform', 'ebay')
      .eq('connected', true)
      .maybeSingle();

    if (account?.access_token) {
      try {
        const ebay = new EbayAdapter(env.ebay);
        const found = await ebay.searchComps(
          {
            brand: attributes.brand,
            keywords: [
              ...(attributes.subcategory ? [attributes.subcategory] : []),
              ...attributes.styleKeywords.slice(0, 3),
              ...(attributes.size ? [attributes.size] : []),
            ],
            category: attributes.category,
            styleNumber: attributes.styleNumber,
            limit: 25,
          },
          {
            accessToken: account.access_token,
            expiresAt: account.token_expires_at ?? undefined,
            meta: (account.meta ?? {}) as Record<string, string>,
          },
        );
        comps.push(...found);
      } catch {
        // Comps are a nice-to-have. A pricing suggestion with lower confidence
        // beats failing the whole analysis because eBay was slow.
      }
    }
  }

  return comps;
}

function scoreInternalComp(
  attributes: ExtractedAttributes,
  row: { brand: string | null; category: string | null; size_normalized: string | null },
): number {
  let score = 0.4;
  if (attributes.brand && row.brand?.toLowerCase() === attributes.brand.toLowerCase()) score += 0.35;
  if (attributes.category && row.category?.toLowerCase() === attributes.category.toLowerCase()) score += 0.15;
  if (attributes.sizeNormalized && row.size_normalized === attributes.sizeNormalized) score += 0.1;
  return Math.min(1, score);
}

async function connectedPlatforms(supabase: SupabaseClient, userId: string): Promise<PlatformId[]> {
  const { data } = await supabase
    .from('marketplace_accounts')
    .select('platform')
    .eq('user_id', userId)
    .eq('connected', true);

  const platforms = (data ?? []).map((row) => row.platform as PlatformId);
  // With nothing connected, write for the tightest common denominator so the
  // copy still adapts cleanly once they do connect something.
  return platforms.length > 0 ? platforms : ['ebay', 'poshmark'];
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

async function assertWithinBudget(
  supabase: SupabaseClient,
  userId: string,
  limitUsd: number,
): Promise<void> {
  const { data, error } = await supabase.rpc('ai_spend_this_month', { p_user_id: userId });
  if (error) return; // never block work because the meter is unreachable

  const spent = Number(data ?? 0);
  if (spent >= limitUsd) throw new BudgetExceededError(spent, limitUsd);
}

async function recordUsage(
  supabase: SupabaseClient,
  userId: string,
  itemId: string,
  usages: Usage[],
): Promise<void> {
  if (usages.length === 0) return;
  await supabase.from('ai_usage').insert(
    usages.map((usage, index) => ({
      user_id: userId,
      item_id: itemId,
      provider: usage.provider,
      model: usage.model,
      operation: index === 0 ? 'extract' : 'write_listing',
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cost_usd: usage.costUsd,
    })),
  );
}

function totalCost(usages: Usage[]): number {
  return usages.reduce((sum, u) => sum + u.costUsd, 0);
}

function toBase64(buffer: ArrayBuffer): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(buffer).toString('base64');
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}
