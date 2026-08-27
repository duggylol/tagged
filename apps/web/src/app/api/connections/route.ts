import { getPlatform, isPlatformId } from '@tagged/core';

import { fail, handleError, ok, readJson } from '@/lib/api-response';
import { toAccount } from '@/lib/mappers';
import { getServerSupabase, requireUser } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireUser();
    const supabase = await getServerSupabase();

    const { data } = await supabase.from('marketplace_accounts').select('*');
    const { data: heartbeats } = await supabase
      .from('extension_heartbeats')
      .select('platform, session_present, last_seen_at');

    return ok({
      accounts: (data ?? []).map(toAccount),
      heartbeats: heartbeats ?? [],
    });
  } catch (error) {
    return handleError(error);
  }
}

interface Body {
  platform: string;
  connected: boolean;
  /** eBay business policy ids, Etsy shop id, and the like. */
  meta?: Record<string, string>;
}

/**
 * Connect or disconnect a marketplace.
 *
 * For extension platforms this is the whole flow — there is nothing to
 * authorize, because Tagged never holds a credential for them. Marking one
 * "connected" says "I sell here and the extension may act on my behalf".
 * API platforms go through /api/oauth/* instead.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const supabase = await getServerSupabase();
    const body = await readJson<Body>(request);

    if (!isPlatformId(body.platform)) return fail('Unknown marketplace.');
    const spec = getPlatform(body.platform);

    if (spec.connection === 'api' && body.connected) {
      return fail(
        `${spec.label} needs to be connected through its sign-in flow, not toggled on.`,
        400,
        'reconnect',
      );
    }

    const { error } = await supabase.from('marketplace_accounts').upsert(
      {
        user_id: user.id,
        platform: body.platform,
        connection_kind: spec.connection,
        connected: body.connected,
        ...(body.meta ? { meta: body.meta } : {}),
        ...(body.connected ? {} : { access_token: null, refresh_token: null }),
      },
      { onConflict: 'user_id,platform' },
    );

    if (error) throw new Error(error.message);
    return ok({ platform: body.platform, connected: body.connected });
  } catch (error) {
    return handleError(error);
  }
}
