import type { ItemStatus } from '@tagged/core';
import Link from 'next/link';

import { Button, Card, Empty, Eyebrow, Money, PlatformChip, StatusPill } from '@/components/ui';
import { toItem, toListing } from '@/lib/mappers';
import { getServerSupabase } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const FILTERS: Array<{ key: string; label: string; statuses: ItemStatus[] }> = [
  { key: 'all', label: 'All', statuses: [] },
  { key: 'draft', label: 'Drafts', statuses: ['draft'] },
  { key: 'active', label: 'Listed', statuses: ['active'] },
  {
    key: 'selling',
    label: 'Selling',
    statuses: ['sale_detected', 'delist_pending', 'awaiting_confirm', 'relisting'],
  },
  { key: 'sold', label: 'Sold', statuses: ['sold'] },
];

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter = 'all' } = await searchParams;
  const supabase = await getServerSupabase();

  const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0]!;

  let query = supabase
    .from('items')
    .select('*')
    .neq('status', 'archived')
    .order('created_at', { ascending: false })
    .limit(200);

  if (active.statuses.length > 0) query = query.in('status', active.statuses);

  const { data: itemRows } = await query;
  const items = (itemRows ?? []).map(toItem);

  const { data: listingRows } = await supabase
    .from('listings')
    .select('*')
    .in('item_id', items.map((i) => i.id).slice(0, 200));

  const listings = (listingRows ?? []).map(toListing);
  const byItem = new Map<string, typeof listings>();
  for (const listing of listings) {
    const list = byItem.get(listing.itemId) ?? [];
    list.push(listing);
    byItem.set(listing.itemId, list);
  }

  return (
    <div className="max-w-5xl">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Eyebrow>Inventory</Eyebrow>
          <h1 className="text-3xl font-extrabold">
            {items.length} item{items.length === 1 ? '' : 's'}
          </h1>
        </div>
        <Link href="/capture">
          <Button>Add items</Button>
        </Link>
      </header>

      <nav className="mb-5 flex gap-1.5 overflow-x-auto pb-1">
        {FILTERS.map((option) => (
          <Link
            key={option.key}
            href={`/inventory?filter=${option.key}`}
            className={`shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors ${
              option.key === active.key
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-hair text-mute hover:text-ink'
            }`}
          >
            {option.label}
          </Link>
        ))}
      </nav>

      {items.length === 0 ? (
        <Empty
          title={active.key === 'all' ? 'Nothing here yet' : `No ${active.label.toLowerCase()}`}
          body={
            active.key === 'all'
              ? 'Photograph your first item from the Capture screen and it will show up here.'
              : 'Try a different filter, or add some items.'
          }
          action={
            <Link href="/capture">
              <Button>Start capturing</Button>
            </Link>
          }
        />
      ) : (
        <ul className="space-y-2.5">
          {items.map((item) => {
            const itemListings = byItem.get(item.id) ?? [];
            const analysing =
              item.analysisStatus !== 'complete' && item.analysisStatus !== 'failed';

            return (
              <Card as="li" key={item.id} className="transition-colors hover:border-accent/40">
                <Link href={`/items/${item.id}`} className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill status={item.status} />
                      {analysing ? (
                        <span className="font-mono text-[10px] uppercase tracking-wider text-amber">
                          analysing…
                        </span>
                      ) : null}
                      {item.analysisStatus === 'failed' ? (
                        <span className="font-mono text-[10px] uppercase tracking-wider text-rust">
                          analysis failed
                        </span>
                      ) : null}
                    </div>

                    <p className="mt-1.5 truncate font-medium text-ink">
                      {item.title ?? `Untitled — ${item.photoPaths.length} photos`}
                    </p>

                    <p className="mt-0.5 truncate text-xs text-mute">
                      {[
                        item.attributes?.brand,
                        item.attributes?.size ? `size ${item.attributes.size}` : null,
                        item.attributes?.condition?.replace(/_/g, ' '),
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'No attributes yet'}
                    </p>

                    {itemListings.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {itemListings.map((listing) => (
                          <PlatformChip
                            key={listing.id}
                            platform={listing.platform}
                            state={listing.state}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <div className="shrink-0 text-right">
                    {item.priceSuggestion ? (
                      <p className="font-display text-lg font-bold text-ink">
                        <Money cents={item.priceSuggestion.listPriceCents} />
                      </p>
                    ) : null}
                    {item.costBasisCents ? (
                      <p className="tnum text-xs text-mute">
                        cost <Money cents={item.costBasisCents} />
                      </p>
                    ) : null}
                  </div>
                </Link>
              </Card>
            );
          })}
        </ul>
      )}
    </div>
  );
}
