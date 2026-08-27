import {
  computeDashboardMetrics,
  computePlatformPerformance,
  computeSourcingSuggestions,
  formatCents,
  getPlatform,
  suggestPriceDrop,
} from '@tagged/core';
import Link from 'next/link';

import { Button, Card, Empty, Eyebrow, Metric, Money, Notice } from '@/components/ui';
import { toItem, toSale } from '@/lib/mappers';
import { getServerSupabase } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * The dashboard.
 *
 * Bias throughout: numbers a reseller runs their business on. Net profit
 * rather than gross revenue, sell-through rather than listing count, cash tied
 * up rather than inventory value. Gross revenue is a vanity metric and every
 * competing tool leads with it.
 */
export default async function DashboardPage() {
  const supabase = await getServerSupabase();

  const [{ data: itemRows }, { data: saleRows }] = await Promise.all([
    supabase.from('items').select('*').order('created_at', { ascending: false }).limit(500),
    supabase.from('sales').select('*').order('detected_at', { ascending: false }).limit(500),
  ]);

  const items = (itemRows ?? []).map(toItem);
  const sales = (saleRows ?? []).map(toSale);

  const metrics = computeDashboardMetrics(items, sales);
  const platforms = computePlatformPerformance(sales, items);
  const suggestions = computeSourcingSuggestions(items, sales);

  const needsConfirm = items.filter((i) => i.status === 'awaiting_confirm');

  const priceDrops = items
    .filter((i) => i.status === 'active' && i.listedAt && i.priceSuggestion)
    .map((item) => {
      const daysListed = Math.floor(
        (Date.now() - new Date(item.listedAt!).getTime()) / 86_400_000,
      );
      const drop = suggestPriceDrop(
        item.priceSuggestion!.listPriceCents,
        daysListed,
        item.priceSuggestion!.floorPriceCents,
      );
      return drop ? { item, daysListed, drop } : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => b.daysListed - a.daysListed)
    .slice(0, 5);

  if (items.length === 0) {
    return (
      <div className="max-w-2xl">
        <Eyebrow>Dashboard</Eyebrow>
        <h1 className="mb-6 text-3xl font-extrabold">Welcome to Tagged</h1>
        <Empty
          title="No inventory yet"
          body="Open Capture on this computer, scan the code with your phone, and photograph your first item. The AI writes the listing while you shoot the next one."
          action={
            <Link href="/capture">
              <Button>Start capturing</Button>
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="max-w-6xl">
      <header className="mb-6">
        <Eyebrow>Dashboard</Eyebrow>
        <h1 className="text-3xl font-extrabold">Your business</h1>
      </header>

      {/* Confirmation queue sits above everything — it is the only thing here
          that is actively blocking money. */}
      {needsConfirm.length > 0 ? (
        <div className="mb-6">
          <Notice tone="warn" title={`${needsConfirm.length} sale${needsConfirm.length === 1 ? '' : 's'} waiting on you`}>
            <p className="mb-3">
              These already came down from your other marketplaces. Confirm once the buyer has paid,
              and the profit is booked.
            </p>
            <ul className="space-y-2">
              {needsConfirm.slice(0, 4).map((item) => (
                <li key={item.id}>
                  <Link
                    href={`/items/${item.id}`}
                    className="flex items-center justify-between rounded-lg bg-card px-3 py-2 text-sm hover:bg-sunk"
                  >
                    <span className="truncate">{item.title ?? 'Untitled item'}</span>
                    <span className="ml-3 shrink-0 text-accent">Confirm →</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Notice>
        </div>
      ) : null}

      <section className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric
          label="Net profit"
          value={<Money cents={metrics.netProfitCents} signed />}
          hint={`After fees and shipping · ${metrics.salesCount} sale${metrics.salesCount === 1 ? '' : 's'}`}
          tone={metrics.netProfitCents >= 0 ? 'good' : 'bad'}
        />
        <Metric
          label="Sell-through"
          value={`${Math.round(metrics.sellThroughRate * 100)}%`}
          hint={
            metrics.medianDaysToSale !== null
              ? `Typically ${metrics.medianDaysToSale} days to sell`
              : 'Not enough sales yet'
          }
        />
        <Metric
          label="Cash tied up"
          value={<Money cents={metrics.cashTiedUpCents} />}
          hint={`${metrics.activeCount} listed · ${metrics.draftCount} draft`}
        />
        <Metric
          label="Aging"
          value={metrics.agingCount}
          hint={`60+ days unsold${metrics.staleCount > 0 ? ` · ${metrics.staleCount} past 90` : ''}`}
          tone={metrics.agingCount > 0 ? 'warn' : 'neutral'}
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Price drops */}
        <Card>
          <Eyebrow>Price drop queue</Eyebrow>
          {priceDrops.length === 0 ? (
            <p className="mt-2 text-sm text-mute">
              Nothing has been sitting long enough to need a cut. Come back when something passes 30 days.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {priceDrops.map(({ item, daysListed, drop }) => (
                <li key={item.id}>
                  <Link
                    href={`/items/${item.id}`}
                    className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-sunk"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm text-ink">{item.title ?? 'Untitled'}</p>
                      <p className="text-xs text-mute">{daysListed} days listed</p>
                    </div>
                    <div className="shrink-0 text-right text-sm">
                      <span className="text-mute line-through">
                        {formatCents(item.priceSuggestion!.listPriceCents)}
                      </span>{' '}
                      <span className="tnum font-medium text-accent">
                        {formatCents(drop.newPriceCents)}
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Platform scorecard */}
        <Card>
          <Eyebrow>Which marketplace is working</Eyebrow>
          {platforms.length === 0 ? (
            <p className="mt-2 text-sm text-mute">
              No confirmed sales yet. Once you have a few, this ranks your marketplaces by what you
              actually keep.
            </p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="border-b border-hair text-left">
                  <th className="pb-2 font-mono text-[10px] uppercase tracking-wider text-mute">Platform</th>
                  <th className="pb-2 text-right font-mono text-[10px] uppercase tracking-wider text-mute">Profit</th>
                  <th className="pb-2 text-right font-mono text-[10px] uppercase tracking-wider text-mute">Days</th>
                </tr>
              </thead>
              <tbody>
                {platforms.map((row) => (
                  <tr key={row.platform} className="border-b border-hair last:border-0">
                    <td className="py-2 text-ink">
                      {getPlatform(row.platform).label}
                      <span className="ml-1.5 text-xs text-mute">×{row.salesCount}</span>
                    </td>
                    <td className="py-2 text-right">
                      <Money cents={row.netProfitCents} signed />
                    </td>
                    <td className="tnum py-2 text-right text-mute">
                      {row.medianDaysToSale ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {/* Sourcing */}
        <Card className="lg:col-span-2">
          <Eyebrow>What to source next</Eyebrow>
          <p className="mt-1 text-xs text-mute">
            Ranked by margin and how fast it turns — from your own sales, not generic advice.
          </p>

          {suggestions.length === 0 ? (
            <p className="mt-3 text-sm text-mute">
              Needs at least two sales of the same brand or category before it can tell you anything
              honest.
            </p>
          ) : (
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {suggestions.map((suggestion) => (
                <li
                  key={`${suggestion.kind}:${suggestion.label}`}
                  className="rounded-lg border border-hair px-3 py-2.5"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium text-ink">{suggestion.label}</span>
                    <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-mute">
                      {suggestion.kind}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-mute">{suggestion.reason}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
