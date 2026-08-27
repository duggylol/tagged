import { generatePairingCode, SESSION_TTL_MINUTES } from '@tagged/core';

import { handleError, ok, readJson } from '@/lib/api-response';
import { requireUser, getServerSupabase } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Open a capture session. Called by the desktop, which then renders the code
 * as a QR for the phone to scan.
 *
 * Reuses an existing unexpired session rather than minting a new code every
 * time the page mounts — otherwise a React re-render invalidates the QR the
 * user is halfway through scanning.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const supabase = await getServerSupabase();
    const body = await readJson<{ hostLabel?: string }>(request).catch(() => ({}) as { hostLabel?: string });

    const { data: existing } = await supabase
      .from('capture_sessions')
      .select('*')
      .eq('user_id', user.id)
      .in('status', ['waiting', 'paired'])
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) return ok({ session: existing, reused: true });

    // Collisions are vanishingly rare but not impossible, and a duplicate code
    // would pair a phone to the wrong desktop. Retry rather than trust luck.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generatePairingCode();
      const { data, error } = await supabase
        .from('capture_sessions')
        .insert({
          user_id: user.id,
          code,
          status: 'waiting',
          host_label: body.hostLabel ?? null,
          expires_at: new Date(Date.now() + SESSION_TTL_MINUTES * 60_000).toISOString(),
        })
        .select('*')
        .single();

      if (!error && data) return ok({ session: data, reused: false });
      if (error && error.code !== '23505') throw new Error(error.message);
    }

    throw new Error('Could not create a pairing code. Try again.');
  } catch (error) {
    return handleError(error);
  }
}

/** Close a session — the desktop leaving the capture screen. */
export async function DELETE(request: Request) {
  try {
    await requireUser();
    const supabase = await getServerSupabase();
    const code = new URL(request.url).searchParams.get('code');
    if (!code) return ok({ closed: false });

    await supabase.from('capture_sessions').update({ status: 'closed' }).eq('code', code);
    return ok({ closed: true });
  } catch (error) {
    return handleError(error);
  }
}
