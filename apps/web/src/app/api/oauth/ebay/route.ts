import { EbayAdapter } from '@tagged/marketplaces';
import { NextResponse } from 'next/server';

import { fail, handleError } from '@/lib/api-response';
import { publicEnv, serverEnv } from '@/lib/env';
import { getServerSupabase, requireUser } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * eBay OAuth — both legs.
 *
 * GET  /api/oauth/ebay            → redirect the seller to eBay
 * GET  /api/oauth/ebay?code=…     → eBay redirects back here with the grant
 *
 * `state` is a random value stored in an httpOnly cookie and compared on
 * return. Without that check, an attacker can trick a signed-in seller into
 * linking the attacker's marketplace account to the seller's Tagged account.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const env = serverEnv();

    if (!env.ebay?.clientId) {
      return fail('eBay is not configured. Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET.', 501);
    }

    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const adapter = new EbayAdapter(env.ebay);

    // --- Leg 1: send them to eBay ---
    if (!code) {
      const state = crypto.randomUUID();
      const response = NextResponse.redirect(adapter.authorizeUrl(state));
      response.cookies.set('ebay_oauth_state', state, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 600,
        path: '/',
      });
      return response;
    }

    // --- Leg 2: they came back ---
    const returnedState = url.searchParams.get('state');
    const expectedState = request.headers
      .get('cookie')
      ?.split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('ebay_oauth_state='))
      ?.split('=')[1];

    if (!returnedState || returnedState !== expectedState) {
      return fail('That eBay sign-in did not come from Tagged. Start again from Connections.', 400);
    }

    const tokens = await adapter.exchangeCode(code);
    const supabase = await getServerSupabase();

    await supabase.from('marketplace_accounts').upsert(
      {
        user_id: user.id,
        platform: 'ebay',
        connection_kind: 'api',
        connected: true,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_expires_at: tokens.expiresAt,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,platform' },
    );

    // The seller still has to pick their business policies before we can list.
    // Send them to the screen that asks, rather than failing at publish time.
    const redirect = NextResponse.redirect(
      `${publicEnv.appUrl}/connections?connected=ebay&setup=policies`,
    );
    redirect.cookies.delete('ebay_oauth_state');
    return redirect;
  } catch (error) {
    return handleError(error);
  }
}
