import { handleError, ok, readJson } from '@/lib/api-response';
import { getServerSupabase, requireUser } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface PatchBody {
  costBasisCents?: number | null;
  sourceNote?: string | null;
  sellerNotes?: string | null;
  title?: string | null;
  /** Seller edits to the generated copy. Their version always wins. */
  listingCore?: unknown;
  priceSuggestion?: unknown;
  status?: 'draft' | 'archived';
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const supabase = await getServerSupabase();
    const { id } = await context.params;
    const body = await readJson<PatchBody>(request);

    const update: Record<string, unknown> = {};
    if ('costBasisCents' in body) update['cost_basis_cents'] = body.costBasisCents;
    if ('sourceNote' in body) update['source_note'] = body.sourceNote;
    if ('sellerNotes' in body) update['seller_notes'] = body.sellerNotes;
    if ('title' in body) update['title'] = body.title;
    if ('listingCore' in body) update['listing_core'] = body.listingCore;
    if ('priceSuggestion' in body) update['price_suggestion'] = body.priceSuggestion;
    if ('status' in body) update['status'] = body.status;

    if (Object.keys(update).length === 0) return ok({ updated: false });

    const { data, error } = await supabase
      .from('items')
      .update(update)
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw new Error(error.message);
    return ok({ item: data });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Archive rather than delete.
 *
 * An item that vanishes takes its sales history and cost basis with it, which
 * breaks the seller's own accounting. Nothing in this app is hard-deleted.
 */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const supabase = await getServerSupabase();
    const { id } = await context.params;

    const { error } = await supabase.from('items').update({ status: 'archived' }).eq('id', id);
    if (error) throw new Error(error.message);

    return ok({ archived: true });
  } catch (error) {
    return handleError(error);
  }
}
