import { isPlatformId, type PlatformId } from '@tagged/core';
import { EXTENSION_PACING } from '@tagged/marketplaces';

import { handleError, ok, readJson } from '@/lib/api-response';
import { getServerSupabase, requireUser } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface Body {
  /** Which marketplaces this browser is currently signed in to. */
  platforms: string[];
  /** Per-platform: is there a live logged-in session right now? */
  sessions?: Record<string, boolean>;
  limit?: number;
}

/**
 * The extension asking for work.
 *
 * Authentication is the browser's own Supabase session cookie — the extension
 * runs in the seller's browser and carries it. It never holds a marketplace
 * credential of any kind; it borrows the session the browser already has.
 *
 * This call doubles as the heartbeat, which is what lets the publish path
 * refuse to queue work for a browser that is not actually there.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const supabase = await getServerSupabase();
    const body = await readJson<Body>(request);

    const platforms = (body.platforms ?? []).filter(isPlatformId) as PlatformId[];
    if (platforms.length === 0) return ok({ commands: [], pacing: EXTENSION_PACING });

    const now = new Date().toISOString();
    await supabase.from('extension_heartbeats').upsert(
      platforms.map((platform) => ({
        user_id: user.id,
        platform,
        session_present: body.sessions?.[platform] === true,
        last_seen_at: now,
      })),
      { onConflict: 'user_id,platform' },
    );

    await supabase
      .from('marketplace_accounts')
      .update({ last_seen_at: now })
      .eq('user_id', user.id)
      .in('platform', platforms);

    // Atomic claim. Two tabs polling at once cannot both pick up the same
    // command and publish the listing twice.
    const { data, error } = await supabase.rpc('claim_extension_commands', {
      p_user_id: user.id,
      p_platforms: platforms,
      p_limit: Math.min(body.limit ?? 5, 10),
    });

    if (error) throw new Error(error.message);

    return ok({
      commands: data ?? [],
      // The extension paces itself from these. They are a safety feature —
      // running faster risks the seller's account standing, not ours.
      pacing: EXTENSION_PACING,
    });
  } catch (error) {
    return handleError(error);
  }
}
