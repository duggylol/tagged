import { isPlatformId, type PlatformId } from '@tagged/core';

import { fail, handleError, ok, readJson } from '@/lib/api-response';
import { handleSaleDetected, reconcileItemStatus } from '@/lib/orchestrator';
import { getServerSupabase, requireUser } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface CommandResult {
  commandId: string;
  ok: boolean;
  externalId?: string;
  externalUrl?: string;
  error?: string;
}

interface SoldReport {
  platform: string;
  externalId: string;
  externalOrderId?: string;
  salePriceCents: number;
  feesCents?: number;
  soldAt: string;
}

interface Body {
  results?: CommandResult[];
  sold?: SoldReport[];
}

/**
 * The extension reporting back.
 *
 * Two payloads arrive here. `results` closes out commands the extension
 * executed — this is where an extension-published listing finally gets its
 * real marketplace id. `sold` is what the extension scraped from the seller's
 * own sold page, which is the sale-detection path for every marketplace
 * without an API.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const supabase = await getServerSupabase();
    const body = await readJson<Body>(request);

    for (const result of body.results ?? []) {
      await applyCommandResult(supabase, user.id, result);
    }

    let salesDetected = 0;
    for (const report of body.sold ?? []) {
      if (!isPlatformId(report.platform)) continue;
      const handled = await recordSold(supabase, user.id, report);
      if (handled) salesDetected += 1;
    }

    return ok({ applied: body.results?.length ?? 0, salesDetected });
  } catch (error) {
    return handleError(error);
  }
}

async function applyCommandResult(
  supabase: Awaited<ReturnType<typeof getServerSupabase>>,
  userId: string,
  result: CommandResult,
): Promise<void> {
  const { data: command } = await supabase
    .from('extension_commands')
    .select('id, kind, platform, payload')
    .eq('id', result.commandId)
    .eq('user_id', userId)
    .maybeSingle();

  if (!command) return;

  await supabase
    .from('extension_commands')
    .update({
      status: result.ok ? 'done' : 'failed',
      finished_at: new Date().toISOString(),
      result: result.ok ? { externalId: result.externalId, externalUrl: result.externalUrl } : null,
      last_error: result.error ?? null,
    })
    .eq('id', command.id);

  const platform = command.platform as PlatformId;
  const payload = command.payload as { itemId?: string; externalId?: string };
  const externalId = payload?.externalId;

  if (command.kind === 'publish') {
    const itemId = payload?.itemId;
    if (!itemId) return;

    await supabase
      .from('listings')
      .update(
        result.ok
          ? {
              state: 'active',
              external_id: result.externalId ?? null,
              external_url: result.externalUrl ?? null,
              published_at: new Date().toISOString(),
              last_error: null,
            }
          : { state: 'error', last_error: result.error ?? 'The extension could not publish this listing.' },
      )
      .eq('item_id', itemId)
      .eq('platform', platform);

    await supabase.from('sync_events').insert({
      user_id: userId,
      item_id: itemId,
      platform,
      kind: result.ok ? 'listing.publish.succeeded' : 'listing.publish.failed',
      payload: { externalId: result.externalId, viaExtension: true },
    });
  }

  if (command.kind === 'end' && externalId) {
    const { data: listing } = await supabase
      .from('listings')
      .select('id, item_id')
      .eq('user_id', userId)
      .eq('platform', platform)
      .eq('external_id', externalId)
      .maybeSingle();

    if (!listing) return;

    await supabase
      .from('listings')
      .update(
        result.ok
          ? { state: 'ended', ended_at: new Date().toISOString(), last_error: null }
          : { state: 'error', last_error: result.error ?? 'The extension could not end this listing.' },
      )
      .eq('id', listing.id);

    // An extension delist finishing is often the last thing standing between
    // the item and the seller's confirm card.
    if (result.ok) await reconcileItemStatus(supabase, listing.item_id as string);
  }
}

async function recordSold(
  supabase: Awaited<ReturnType<typeof getServerSupabase>>,
  userId: string,
  report: SoldReport,
): Promise<boolean> {
  const platform = report.platform as PlatformId;

  // Buffer it regardless — the unique index makes a repeated report a no-op.
  await supabase.from('extension_sold_reports').upsert(
    {
      user_id: userId,
      platform,
      external_id: report.externalId,
      external_order_id: report.externalOrderId ?? '',
      sale_price_cents: report.salePriceCents,
      fees_cents: report.feesCents ?? null,
      sold_at: report.soldAt,
    },
    { onConflict: 'user_id,platform,external_id,external_order_id', ignoreDuplicates: true },
  );

  const { data: listing } = await supabase
    .from('listings')
    .select('item_id')
    .eq('user_id', userId)
    .eq('platform', platform)
    .eq('external_id', report.externalId)
    .maybeSingle();

  if (!listing) return false;

  await handleSaleDetected(supabase, userId, {
    itemId: listing.item_id as string,
    platform,
    salePriceCents: report.salePriceCents,
    feesCents: report.feesCents ?? null,
    externalOrderId: report.externalOrderId,
    detectionSource: 'extension',
    soldAt: report.soldAt,
  });

  return true;
}
