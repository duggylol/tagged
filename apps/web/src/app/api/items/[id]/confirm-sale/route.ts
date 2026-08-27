import { handleError, ok, readJson } from '@/lib/api-response';
import { cancelSaleAndRelist, confirmSale } from '@/lib/orchestrator';
import { getAdminSupabase, getServerSupabase, requireUser } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface Body {
  /** 'confirm' books the profit. 'cancel' relists everywhere from snapshot. */
  action: 'confirm' | 'cancel';
  shippingCents?: number;
  costBasisCents?: number;
}

/**
 * The human gate.
 *
 * Listings already came down automatically when the sale was detected — that
 * part cannot wait for a person. But nothing is archived and no profit is
 * booked until the seller taps confirm here, which is what makes a cancelled
 * or fraudulent order recoverable instead of destructive.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const supabase = await getServerSupabase();
    const { id } = await context.params;
    const body = await readJson<Body>(request);

    if (body.action === 'cancel') {
      const result = await cancelSaleAndRelist(supabase, user.id, id);
      return ok({ action: 'cancel', ...result });
    }

    const admin = getAdminSupabase();
    await confirmSale(supabase, admin, user.id, id, {
      shippingCents: body.shippingCents,
      costBasisCents: body.costBasisCents,
    });

    return ok({ action: 'confirm' });
  } catch (error) {
    return handleError(error);
  }
}
