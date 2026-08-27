import { handleError, fail, ok, readJson } from '@/lib/api-response';
import { runPipeline } from '@/lib/pipeline';
import { getAdminSupabase, getServerSupabase, requireUser } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
// Two model calls plus image downloads. The default edge timeout is too short.
export const maxDuration = 60;

interface Body {
  sessionId: string;
  /** Photo ids captured for this item since the last finish. */
  photoIds: string[];
  sellerNotes?: string;
  costBasisCents?: number;
}

/**
 * "Next item" on the phone.
 *
 * This is the hinge of the whole phone→PC flow: it closes the current group of
 * photos into a real item and kicks off analysis. The desktop is already
 * watching `items` over Realtime, so a draft listing materializes there
 * without anyone touching the computer.
 *
 * Analysis runs in the background on purpose — the phone gets its response
 * immediately and the seller starts shooting the next garment while the model
 * works on the last one.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const supabase = await getServerSupabase();
    const body = await readJson<Body>(request);

    if (!body.photoIds?.length) {
      return fail('No photos to group into an item.');
    }

    const { data: photos } = await supabase
      .from('capture_photos')
      .select('id, storage_path, phash, sequence')
      .eq('session_id', body.sessionId)
      .eq('user_id', user.id)
      .in('id', body.photoIds)
      .order('sequence');

    if (!photos?.length) return fail('Those photos are not in this session.');

    const paths = photos.map((p) => p.storage_path as string);

    const { data: item, error: itemError } = await supabase
      .from('items')
      .insert({
        user_id: user.id,
        status: 'draft',
        analysis_status: 'pending',
        photo_paths: paths,
        phash: (photos[0]?.phash as string) ?? null,
        seller_notes: body.sellerNotes ?? null,
        cost_basis_cents: body.costBasisCents ?? null,
      })
      .select('*')
      .single();

    if (itemError || !item) throw new Error(itemError?.message ?? 'Could not create the item.');

    await supabase
      .from('capture_photos')
      .update({ item_id: item.id })
      .in('id', body.photoIds);

    await supabase
      .from('capture_sessions')
      .update({ current_item_id: null })
      .eq('id', body.sessionId);

    // Duplicate check — a seller about to relist something already sold.
    const duplicate = await findDuplicate(supabase, user.id, item.id, photos[0]?.phash as string | null);

    await supabase.from('sync_events').insert({
      user_id: user.id,
      item_id: item.id,
      kind: 'analysis.started',
      payload: { photoCount: paths.length, source: 'phone_capture' },
    });

    // Fire and forget. The phone must not wait ~8 seconds for two model calls
    // before it can photograph the next garment.
    const admin = getAdminSupabase();
    void runPipeline(supabase, admin, user.id, item.id).catch((error) => {
      console.error('[tagged] background analysis failed', error);
    });

    return ok({ item, duplicate }, 201);
  } catch (error) {
    return handleError(error);
  }
}

async function findDuplicate(
  supabase: Awaited<ReturnType<typeof getServerSupabase>>,
  userId: string,
  itemId: string,
  phash: string | null,
): Promise<{ id: string; title: string | null; status: string } | null> {
  if (!phash) return null;

  // Exact hash match only. A near-match search needs a Hamming-distance index
  // this table does not have yet; catching the exact-duplicate case covers the
  // common mistake of shooting the same garment twice in one haul.
  const { data } = await supabase
    .from('items')
    .select('id, title, status')
    .eq('user_id', userId)
    .eq('phash', phash)
    .neq('id', itemId)
    .limit(1)
    .maybeSingle();

  return data
    ? { id: data.id as string, title: (data.title as string) ?? null, status: data.status as string }
    : null;
}
