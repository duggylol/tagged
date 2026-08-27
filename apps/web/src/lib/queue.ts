import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlatformId } from '@tagged/core';
import type { ExtensionCommand, ExtensionQueue, SoldItem } from '@tagged/marketplaces';

/**
 * The extension command queue, backed by Postgres.
 *
 * `@tagged/marketplaces` defines the interface and stays storage-agnostic so
 * it can be unit tested without a database; this is the one implementation.
 */
export class SupabaseExtensionQueue implements ExtensionQueue {
  constructor(private readonly supabase: SupabaseClient) {}

  async enqueue(
    command: Omit<ExtensionCommand, 'id' | 'status' | 'attempts' | 'createdAt'>,
  ): Promise<string> {
    const { data, error } = await this.supabase
      .from('extension_commands')
      .upsert(
        {
          user_id: command.userId,
          platform: command.platform,
          kind: command.kind,
          payload: command.payload,
          idempotency_key: command.idempotencyKey,
        },
        // The unique index on idempotency_key is what makes a retry safe.
        // Re-queuing the same intent is a no-op, not a duplicate listing.
        { onConflict: 'idempotency_key', ignoreDuplicates: true },
      )
      .select('id')
      .maybeSingle();

    if (error && error.code !== '23505') {
      throw new Error(`Could not queue the command: ${error.message}`);
    }

    if (data?.id) return data.id as string;

    const { data: existing } = await this.supabase
      .from('extension_commands')
      .select('id')
      .eq('idempotency_key', command.idempotencyKey)
      .maybeSingle();

    return (existing?.id as string) ?? '';
  }

  async lastSeen(userId: string, platform: PlatformId): Promise<Date | null> {
    const { data } = await this.supabase
      .from('extension_heartbeats')
      .select('last_seen_at')
      .eq('user_id', userId)
      .eq('platform', platform)
      .maybeSingle();

    return data?.last_seen_at ? new Date(data.last_seen_at as string) : null;
  }

  /**
   * Take the sold reports the extension has pushed up and mark them consumed,
   * so the sale-detection sweep cannot process the same sale twice.
   */
  async drainSold(userId: string, platform: PlatformId, since: Date): Promise<SoldItem[]> {
    const { data } = await this.supabase
      .from('extension_sold_reports')
      .select('id, external_id, external_order_id, sale_price_cents, fees_cents, sold_at')
      .eq('user_id', userId)
      .eq('platform', platform)
      .is('consumed_at', null)
      .gte('sold_at', since.toISOString())
      .limit(50);

    const rows = data ?? [];
    if (rows.length === 0) return [];

    await this.supabase
      .from('extension_sold_reports')
      .update({ consumed_at: new Date().toISOString() })
      .in(
        'id',
        rows.map((r) => r.id),
      );

    return rows.map((row) => ({
      externalId: row.external_id as string,
      externalOrderId: (row.external_order_id as string) ?? '',
      salePriceCents: (row.sale_price_cents as number) ?? 0,
      feesCents: (row.fees_cents as number) ?? null,
      soldAt: row.sold_at as string,
      buyerHandle: null,
    }));
  }
}
