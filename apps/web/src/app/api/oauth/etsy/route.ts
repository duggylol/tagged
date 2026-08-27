import { EtsyAdapter } from '@tagged/marketplaces';
import { NextResponse } from 'next/server';

import { fail, handleError } from '@/lib/api-response';
import { publicEnv, serverEnv } from '@/lib/env';
import { getServerSupabase, requireUser } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Etsy OAuth. Etsy mandates PKCE, so a per-attempt verifier is generated,
 * stashed in an httpOnly cookie, and sent back on the exchange.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const env = serverEnv();

    if (!env.etsy?.clientId) {
      return fail('Etsy is not configured. Set ETSY_CLIENT_ID and ETSY_CLIENT_SECRET.', 501);
    }

    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const adapter = new EtsyAdapter(env.etsy);

    if (!code) {
      const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
      const challenge = await pkceChallenge(verifier);
      const state = crypto.randomUUID();

      const response = NextResponse.redirect(adapter.authorizeUrl(state, challenge));
      const cookieOpts = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax' as const,
        maxAge: 600,
        path: '/',
      };
      response.cookies.set('etsy_oauth_state', state, cookieOpts);
      response.cookies.set('etsy_oauth_verifier', verifier, cookieOpts);
      return response;
    }

    const cookies = parseCookies(request.headers.get('cookie'));
    const returnedState = url.searchParams.get('state');

    if (!returnedState || returnedState !== cookies['etsy_oauth_state']) {
      return fail('That Etsy sign-in did not come from Tagged. Start again from Connections.', 400);
    }

    const verifier = cookies['etsy_oauth_verifier'];
    if (!verifier) return fail('The Etsy sign-in timed out. Start again from Connections.', 400);

    const tokens = await adapter.exchangeCode(code, verifier);

    // Etsy's access token is prefixed with the user id: "12345678.abcdef…".
    const externalUserId = tokens.accessToken.split('.')[0] ?? '';
    const shop = await fetchShop(env.etsy.clientId, tokens.accessToken, externalUserId);

    const supabase = await getServerSupabase();
    await supabase.from('marketplace_accounts').upsert(
      {
        user_id: user.id,
        platform: 'etsy',
        connection_kind: 'api',
        connected: true,
        external_username: shop?.shopName ?? null,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_expires_at: tokens.expiresAt,
        meta: shop?.shopId ? { shopId: shop.shopId } : {},
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,platform' },
    );

    const redirect = NextResponse.redirect(`${publicEnv.appUrl}/connections?connected=etsy`);
    redirect.cookies.delete('etsy_oauth_state');
    redirect.cookies.delete('etsy_oauth_verifier');
    return redirect;
  } catch (error) {
    return handleError(error);
  }
}

async function fetchShop(
  clientId: string,
  accessToken: string,
  userId: string,
): Promise<{ shopId: string; shopName: string } | null> {
  if (!userId) return null;
  try {
    const response = await fetch(`https://api.etsy.com/v3/application/users/${userId}/shops`, {
      headers: { authorization: `Bearer ${accessToken}`, 'x-api-key': clientId },
    });
    if (!response.ok) return null;

    const json = (await response.json()) as { shop_id?: number; shop_name?: string };
    return json.shop_id
      ? { shopId: String(json.shop_id), shopName: json.shop_name ?? '' }
      : null;
  } catch {
    return null;
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header?.split(';') ?? []) {
    const [key, ...rest] = part.trim().split('=');
    if (key) out[key] = rest.join('=');
  }
  return out;
}
