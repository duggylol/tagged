import { API_PLATFORMS, type PlatformId } from '@tagged/core';
import { getAdapter } from '@tagged/marketplaces';

import { fail, handleError, ok } from '@/lib/api-response';
import { serverEnv } from '@/lib/env';
import { handleSaleDetected } from '@/lib/orchestrator';
import { SupabaseExtensionQueue } from '@/lib/queue';
import { getAdminSupabase } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Scheduled sale detection for the API marketplaces.
 *
 * eBay has webhooks and fires within seconds; Etsy has none at all, so
 * receipts get polled. Run this every five minutes from a Cloudflare Worker
 * cron trigger (free) or `vercel.json` crons.
 *
 * Extension marketplaces do not appear here — they push to /api/extension/report
 * from the seller's browser instead.
 */
export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret) return fail('CRON_SECRET is not configured on the server.', 500);

    const provided =
      request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
      new URL(request.url).searchParams.get('secret');

    if (provided !== secret) return fail('Not authorized.', 401);

    const admin = getAdminSupabase();
    const env = serverEnv();
    const lookback = new Date(Date.now() - 6 * 60 * 60 * 1000); // 6h, well past any gap

    const platformIds = API_PLATFORMS.filter((p) => p.enabled).map((p) => p.id);

    const { data: accounts } = await admin
      .from('marketplace_accounts')
      .select('user_id, platform, access_token, refresh_token, token_expires_at, meta')
      .eq('connected', true)
      .in('platform', platformIds);

    let checked = 0;
    let detected = 0;
    const errors: Array<{ userId: string; platform: string; message: string }> = [];

    for (const account of accounts ?? []) {
      const platform = account.platform as PlatformId;
      const userId = account.user_id as string;
      checked += 1;

      try {
        const adapter = getAdapter(platform, {
          userId,
          extensionQueue: new SupabaseExtensionQueue(admin),
          ebay: env.ebay,
          etsy: env.etsy,
        });

        const sold = await adapter.fetchSold(lookback, {
          accessToken: (account.access_token as string) ?? undefined,
          refreshToken: (account.refresh_token as string) ?? undefined,
          expiresAt: (account.token_expires_at as string) ?? undefined,
          meta: (account.meta ?? {}) as Record<string, string>,
        });

        for (const sale of sold) {
          // Only care about listings Tagged actually created — the seller may
          // well have other inventory on that marketplace.
          const { data: listing } = await admin
            .from('listings')
            .select('item_id')
            .eq('user_id', userId)
            .eq('platform', platform)
            .eq('external_id', sale.externalId)
            .maybeSingle();

          if (!listing) continue;

          await handleSaleDetected(admin, userId, {
            itemId: listing.item_id as string,
            platform,
            salePriceCents: sale.salePriceCents,
            feesCents: sale.feesCents,
            externalOrderId: sale.externalOrderId,
            detectionSource: platform === 'ebay' ? 'webhook' : 'poll',
            soldAt: sale.soldAt,
          });

          detected += 1;
        }
      } catch (cause) {
        // One seller's expired token must not stop the sweep for everyone else.
        errors.push({
          userId,
          platform,
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }

    return ok({ checked, detected, errors });
  } catch (error) {
    return handleError(error);
  }
}
