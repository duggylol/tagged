'use client';

import {
  adaptListing,
  calculateNetProceeds,
  ENABLED_PLATFORMS,
  formatCents,
  getPlatform,
  isPlatformId,
  MIN_PUBLISH_CONFIDENCE,
  parseDollars,
  priceForPlatform,
  type Item,
  type Listing,
  type PlatformId,
} from '@tagged/core';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import {
  Button,
  Card,
  ConfidenceBar,
  Eyebrow,
  Field,
  Money,
  Notice,
  PlatformChip,
  StatusPill,
  inputClass,
} from './ui';

/**
 * The review-and-publish screen.
 *
 * Two things here are load-bearing rather than decorative:
 *
 *  1. Nothing auto-publishes. Below `MIN_PUBLISH_CONFIDENCE` the seller has to
 *     tick an explicit acknowledgement. A mis-identified listing costs them a
 *     return, a refund, and a rating hit — the cheap fix is ten seconds of
 *     human attention.
 *
 *  2. Prices are shown as NET, per platform. A $40 Poshmark sale keeps less
 *     than a $32 eBay sale once the 20% commission lands, and a seller who
 *     cannot see that prices wrong on both.
 */

interface Props {
  item: Item;
  listings: Listing[];
  photoUrls: string[];
  connectedPlatforms: string[];
  pendingSale: { platform: string; salePriceCents: number; detectedAt: string } | null;
}

export function ItemWorkbench({ item, listings, photoUrls, connectedPlatforms, pendingSale }: Props) {
  const router = useRouter();

  const connected = useMemo(
    () => connectedPlatforms.filter(isPlatformId) as PlatformId[],
    [connectedPlatforms],
  );

  const [selected, setSelected] = useState<PlatformId[]>(() =>
    connected.filter((p) => !listings.some((l) => l.platform === p && l.state === 'active')),
  );
  const [priceOverrides, setPriceOverrides] = useState<Partial<Record<PlatformId, number>>>({});
  const [costBasis, setCostBasis] = useState(
    item.costBasisCents !== null ? (item.costBasisCents / 100).toFixed(2) : '',
  );
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'info' | 'warn' | 'error'; text: string } | null>(null);

  const analysing = item.analysisStatus !== 'complete' && item.analysisStatus !== 'failed';
  const confidence = item.attributes?.confidence ?? 0;
  const needsExplicitReview = confidence < MIN_PUBLISH_CONFIDENCE;

  async function call(path: string, body: unknown, label: string) {
    setBusy(label);
    setMessage(null);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? 'That did not work.');
      router.refresh();
      return json;
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : 'That did not work.',
      });
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    const result = await call(
      `/api/items/${item.id}/publish`,
      { platforms: selected, priceOverrides, reviewed: true },
      'publish',
    );
    if (!result) return;

    const outcomes = (result.outcomes ?? []) as Array<{
      platform: PlatformId;
      ok: boolean;
      pending?: boolean;
      error?: string;
    }>;

    const failed = outcomes.filter((o) => !o.ok);
    const pending = outcomes.filter((o) => o.pending);

    if (failed.length > 0) {
      setMessage({
        tone: 'warn',
        text: `Published to ${outcomes.length - failed.length}. Failed: ${failed
          .map((f) => `${getPlatform(f.platform).label} (${f.error})`)
          .join('; ')}`,
      });
    } else if (pending.length > 0) {
      setMessage({
        tone: 'info',
        text: `Queued for ${pending
          .map((p) => getPlatform(p.platform).label)
          .join(', ')} — your browser extension will publish them shortly.`,
      });
    } else {
      setMessage({ tone: 'info', text: 'Published everywhere.' });
    }
  }

  async function saveCostBasis() {
    const cents = parseDollars(costBasis);
    await call(`/api/items/${item.id}`, { costBasisCents: cents }, 'cost');
  }

  // ---------------------------------------------------------------------------

  return (
    <div className="max-w-5xl">
      <header className="mb-5">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <StatusPill status={item.status} showHint />
        </div>
        <h1 className="text-2xl font-extrabold md:text-3xl">
          {item.title ?? 'Untitled item'}
        </h1>
      </header>

      {message ? (
        <div className="mb-5">
          <Notice tone={message.tone}>{message.text}</Notice>
        </div>
      ) : null}

      {/* The confirm-sale gate. Listings are already down; this books the money. */}
      {pendingSale && item.status === 'awaiting_confirm' ? (
        <Card className="mb-5 border-amber">
          <Eyebrow>Confirm this sale</Eyebrow>
          <p className="mt-1 text-sm">
            Sold on <strong>{getPlatform(pendingSale.platform as PlatformId).label}</strong> for{' '}
            <Money cents={pendingSale.salePriceCents} /> — already removed from your other
            marketplaces. Nothing is booked until you confirm.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              onClick={() =>
                call(
                  `/api/items/${item.id}/confirm-sale`,
                  { action: 'confirm', costBasisCents: parseDollars(costBasis) ?? undefined },
                  'confirm',
                )
              }
              disabled={busy !== null}
            >
              {busy === 'confirm' ? 'Booking…' : 'Confirm — buyer paid'}
            </Button>
            <Button
              variant="danger"
              onClick={() => call(`/api/items/${item.id}/confirm-sale`, { action: 'cancel' }, 'cancel')}
              disabled={busy !== null}
            >
              {busy === 'cancel' ? 'Relisting…' : 'Sale fell through — relist everywhere'}
            </Button>
          </div>
        </Card>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          {/* Photos */}
          {photoUrls.length > 0 ? (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {photoUrls.map((url, index) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={url}
                  src={url}
                  alt={`Item photo ${index + 1}`}
                  className="aspect-square w-full rounded-lg border border-hair object-cover"
                />
              ))}
            </div>
          ) : null}

          {/* Analysis state */}
          {analysing ? (
            <Notice tone="info" title="Analysing">
              Reading the photos and checking comps. This page updates when it finishes.
            </Notice>
          ) : null}

          {item.analysisStatus === 'failed' ? (
            <Notice tone="error" title="Analysis failed">
              <p className="mb-3">Try again — most failures are a transient model or network error.</p>
              <Button
                variant="secondary"
                onClick={() => call(`/api/items/${item.id}/analyze`, {}, 'analyze')}
                disabled={busy !== null}
              >
                {busy === 'analyze' ? 'Running…' : 'Re-run analysis'}
              </Button>
            </Notice>
          ) : null}

          {/* Attributes */}
          {item.attributes ? (
            <Card>
              <div className="mb-3">
                <ConfidenceBar value={item.attributes.confidence} />
              </div>

              <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm sm:grid-cols-3">
                {[
                  ['Brand', item.attributes.brand],
                  ['Size', item.attributes.size],
                  ['Category', item.attributes.subcategory ?? item.attributes.category],
                  ['Colour', item.attributes.colors.join(', ')],
                  ['Material', item.attributes.material],
                  ['Condition', item.attributes.condition?.replace(/_/g, ' ')],
                  ['Era', item.attributes.era],
                  ['Style no.', item.attributes.styleNumber],
                  ['Made in', item.attributes.countryOfOrigin],
                ]
                  .filter(([, value]) => value)
                  .map(([label, value]) => (
                    <div key={label as string}>
                      <dt className="eyebrow">{label}</dt>
                      <dd className="text-ink">{value as string}</dd>
                    </div>
                  ))}
              </dl>

              {item.attributes.defects.length > 0 ? (
                <div className="mt-4 border-t border-hair pt-3">
                  <Eyebrow>Flaws found</Eyebrow>
                  <ul className="mt-1 space-y-1 text-sm text-body">
                    {item.attributes.defects.map((defect, index) => (
                      <li key={index}>• {defect.disclosure}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {item.attributes.uncertainNotes.length > 0 ? (
                <div className="mt-4 border-t border-hair pt-3">
                  <Eyebrow>Worth checking</Eyebrow>
                  <ul className="mt-1 space-y-1 text-sm text-mute">
                    {item.attributes.uncertainNotes.map((note, index) => (
                      <li key={index}>• {note}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </Card>
          ) : null}

          {/* Per-platform previews */}
          {item.listingCore && item.priceSuggestion ? (
            <div>
              <Eyebrow>How it looks on each marketplace</Eyebrow>
              <div className="mt-2 space-y-3">
                {(selected.length > 0 ? selected : connected).map((platform) => {
                  const spec = getPlatform(platform);
                  const preview = adaptListing(platform, {
                    core: item.listingCore!,
                    attributes: item.attributes,
                    price: item.priceSuggestion!,
                    priceCentsOverride: priceOverrides[platform],
                  });

                  return (
                    <Card key={platform}>
                      <div className="mb-2 flex items-center justify-between">
                        <PlatformChip platform={platform} />
                        <span className="tnum font-mono text-[11px] text-mute">
                          {preview.title.length}/{spec.title.maxChars} chars
                        </span>
                      </div>

                      <p className="font-medium text-ink">{preview.title}</p>
                      <p className="mt-2 whitespace-pre-wrap text-sm text-body">
                        {preview.description.slice(0, 400)}
                        {preview.description.length > 400 ? '…' : ''}
                      </p>

                      {preview.tags.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {preview.tags.map((tag) => (
                            <span
                              key={tag}
                              className="rounded bg-sunk px-1.5 py-0.5 font-mono text-[10px] text-mute"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      ) : null}

                      {preview.warnings.length > 0 ? (
                        <ul className="mt-3 space-y-1 border-t border-hair pt-2 text-xs text-amber">
                          {preview.warnings.map((warning, index) => (
                            <li key={index}>⚠ {warning}</li>
                          ))}
                        </ul>
                      ) : null}
                    </Card>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>

        {/* Sidebar: pricing and publish */}
        <aside className="space-y-4">
          {item.priceSuggestion ? (
            <Card>
              <Eyebrow>Pricing</Eyebrow>
              <p className="mt-1 font-display text-3xl font-extrabold text-ink">
                <Money cents={item.priceSuggestion.listPriceCents} />
              </p>
              <p className="tnum mt-1 text-xs text-mute">
                Floor {formatCents(item.priceSuggestion.floorPriceCents)} · market{' '}
                {formatCents(item.priceSuggestion.p25Cents)}–
                {formatCents(item.priceSuggestion.p75Cents)}
              </p>
              <p className="mt-2 text-xs text-mute">{item.priceSuggestion.rationale}</p>

              <div className="mt-3">
                <Field label="What you paid">
                  <div className="flex gap-2">
                    <input
                      value={costBasis}
                      onChange={(e) => setCostBasis(e.target.value)}
                      onBlur={saveCostBasis}
                      placeholder="0.00"
                      inputMode="decimal"
                      className={inputClass}
                    />
                  </div>
                </Field>
              </div>
            </Card>
          ) : null}

          {/* Net proceeds — the number every other tool hides. */}
          {item.priceSuggestion && connected.length > 0 ? (
            <Card>
              <Eyebrow>What you keep</Eyebrow>
              <ul className="mt-2 space-y-2">
                {connected.map((platform) => {
                  const price = priceOverrides[platform] ?? priceForPlatform(item.priceSuggestion!, platform);
                  const proceeds = calculateNetProceeds({
                    platform,
                    salePriceCents: price,
                    costBasisCents: parseDollars(costBasis) ?? 0,
                  });

                  return (
                    <li key={platform} className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="text-mute">{getPlatform(platform).label}</span>
                      <span className="text-right">
                        <span className="tnum text-ink">{formatCents(price)}</span>
                        <span className="mx-1 text-mute">→</span>
                        <Money cents={proceeds.profitCents} signed className="font-medium" />
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-2 text-[11px] text-mute">
                After commission, payment fees and your cost. Verify fee rates before trusting these
                to the dollar.
              </p>
            </Card>
          ) : null}

          {/* Publish */}
          <Card>
            <Eyebrow>Publish to</Eyebrow>

            {connected.length === 0 ? (
              <p className="mt-2 text-sm text-mute">
                No marketplaces connected yet. Add one from Connections first.
              </p>
            ) : (
              <>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {ENABLED_PLATFORMS.filter((spec) => connected.includes(spec.id)).map((spec) => {
                    const existing = listings.find((l) => l.platform === spec.id);
                    const isLive = existing?.state === 'active';

                    return (
                      <PlatformChip
                        key={spec.id}
                        platform={spec.id}
                        state={isLive ? 'active' : undefined}
                        selected={selected.includes(spec.id)}
                        onClick={
                          isLive
                            ? undefined
                            : () =>
                                setSelected((prev) =>
                                  prev.includes(spec.id)
                                    ? prev.filter((p) => p !== spec.id)
                                    : [...prev, spec.id],
                                )
                        }
                      />
                    );
                  })}
                </div>

                {needsExplicitReview ? (
                  <label className="mt-4 flex cursor-pointer items-start gap-2 rounded-lg bg-amber-soft/50 p-2.5 text-xs">
                    <input
                      type="checkbox"
                      checked={reviewed}
                      onChange={(e) => setReviewed(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      The AI was only {Math.round(confidence * 100)}% confident. I have checked the
                      brand, size and condition above.
                    </span>
                  </label>
                ) : null}

                <div className="mt-4">
                  <Button
                    onClick={publish}
                    disabled={
                      busy !== null ||
                      selected.length === 0 ||
                      !item.listingCore ||
                      (needsExplicitReview && !reviewed)
                    }
                    full
                  >
                    {busy === 'publish'
                      ? 'Publishing…'
                      : `Publish to ${selected.length || 'no'} marketplace${selected.length === 1 ? '' : 's'}`}
                  </Button>
                </div>
              </>
            )}
          </Card>

          {/* Live listings */}
          {listings.length > 0 ? (
            <Card>
              <Eyebrow>Live listings</Eyebrow>
              <ul className="mt-2 space-y-2 text-sm">
                {listings.map((listing) => (
                  <li key={listing.id} className="flex items-center justify-between gap-2">
                    <PlatformChip platform={listing.platform} state={listing.state} />
                    {listing.externalUrl ? (
                      <a
                        href={listing.externalUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-xs text-accent hover:underline"
                      >
                        View →
                      </a>
                    ) : listing.lastError ? (
                      <span className="max-w-[55%] truncate text-xs text-rust" title={listing.lastError}>
                        {listing.lastError}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {!analysing && item.analysisStatus === 'complete' ? (
            <Button
              variant="ghost"
              onClick={() => call(`/api/items/${item.id}/analyze`, {}, 'analyze')}
              disabled={busy !== null}
              full
            >
              {busy === 'analyze' ? 'Re-analysing…' : 'Re-run the AI'}
            </Button>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
