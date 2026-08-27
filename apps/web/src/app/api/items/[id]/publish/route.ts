import { isPlatformId, type PlatformId } from '@tagged/core';

import { fail, handleError, ok, readJson } from '@/lib/api-response';
import { publishItem } from '@/lib/orchestrator';
import { getServerSupabase, requireUser } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
// Publishing uploads images to each marketplace in turn.
export const maxDuration = 300;

interface Body {
  platforms: string[];
  priceOverrides?: Record<string, number>;
  /**
   * The seller has seen the draft and approved it. Required — nothing
   * auto-publishes, whatever the model's confidence, because a wrong listing
   * costs them a return, a refund and a rating hit.
   */
  reviewed: boolean;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const supabase = await getServerSupabase();
    const { id } = await context.params;
    const body = await readJson<Body>(request);

    if (!body.reviewed) {
      return fail('Listings must be reviewed before they can be published.', 422);
    }

    const platforms = (body.platforms ?? []).filter(isPlatformId);
    if (platforms.length === 0) {
      return fail('Pick at least one marketplace to publish to.');
    }

    const overrides: Partial<Record<PlatformId, number>> = {};
    for (const [key, value] of Object.entries(body.priceOverrides ?? {})) {
      if (isPlatformId(key) && typeof value === 'number' && value > 0) {
        overrides[key] = Math.round(value);
      }
    }

    const outcomes = await publishItem(supabase, user.id, id, platforms, overrides);

    const anyOk = outcomes.some((o) => o.ok);
    return ok({ outcomes }, anyOk ? 200 : 502);
  } catch (error) {
    return handleError(error);
  }
}
