import { handleError, ok } from '@/lib/api-response';
import { runPipeline } from '@/lib/pipeline';
import { getAdminSupabase, getServerSupabase, requireUser } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Run (or re-run) the AI pass on one item. */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const supabase = await getServerSupabase();
    const admin = getAdminSupabase();
    const { id } = await context.params;

    await supabase.from('sync_events').insert({
      user_id: user.id,
      item_id: id,
      kind: 'analysis.started',
      payload: { source: 'manual' },
    });

    const result = await runPipeline(supabase, admin, user.id, id);
    return ok(result);
  } catch (error) {
    return handleError(error);
  }
}
