import { handleError, fail, ok, readJson } from '@/lib/api-response';
import { requireUser, getServerSupabase } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * The phone joining a session.
 *
 * The code is a convenience for finding the session, not the authorization for
 * it — the phone must be signed in as the same account. A six-character code
 * is short enough to type across a room, which also makes it short enough to
 * guess, so it is deliberately not a bearer credential.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const supabase = await getServerSupabase();
    const { code, guestLabel } = await readJson<{ code: string; guestLabel?: string }>(request);

    if (!code) return fail('No pairing code provided.');

    const { data: session } = await supabase
      .from('capture_sessions')
      .select('*')
      .eq('code', code.toUpperCase())
      .eq('user_id', user.id)
      .maybeSingle();

    if (!session) {
      return fail(
        'That pairing code does not match a session on your account. Open the Capture screen on your computer and scan the code shown there.',
        404,
      );
    }

    if (new Date(session.expires_at as string).getTime() < Date.now()) {
      await supabase.from('capture_sessions').update({ status: 'expired' }).eq('id', session.id);
      return fail('That pairing code has expired. Refresh the Capture screen on your computer.', 410);
    }

    if (session.status === 'closed') {
      return fail('That capture session was closed on the computer.', 410);
    }

    const { data: updated, error } = await supabase
      .from('capture_sessions')
      .update({ status: 'paired', guest_label: guestLabel ?? null })
      .eq('id', session.id)
      .select('*')
      .single();

    if (error) throw new Error(error.message);

    return ok({ session: updated });
  } catch (error) {
    return handleError(error);
  }
}
