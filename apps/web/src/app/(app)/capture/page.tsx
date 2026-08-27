'use client';

import { pairingUrl, type CaptureSession, type Item } from '@tagged/core';
import Link from 'next/link';
import QRCode from 'qrcode';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, Card, ConfidenceBar, Empty, Eyebrow, Money, Notice, StatusPill } from '@/components/ui';
import { publicEnv } from '@/lib/env';
import { toItem } from '@/lib/mappers';
import { describeDevice, isPhoneFormFactor } from '@/lib/platform/capabilities';
import { getSupabaseClient } from '@/lib/supabase/client';

/**
 * The desktop side of phone → PC capture.
 *
 * Opens a session, renders the QR, then sits and watches. Photos appear in the
 * tray as the phone shoots them; finished items appear below with their
 * analysis progressing through the stages in real time. Nobody touches the
 * computer during a shoot — that is the whole point.
 */

interface PhotoRow {
  id: string;
  storage_path: string;
  role: string;
  item_id: string | null;
  created_at: string;
}

export default function CapturePage() {
  const [session, setSession] = useState<CaptureSession | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [photos, setPhotos] = useState<PhotoRow[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [onPhone, setOnPhone] = useState(false);

  const sessionRef = useRef<CaptureSession | null>(null);

  // --- Open the session -----------------------------------------------------
  useEffect(() => {
    setOnPhone(isPhoneFormFactor());
    let cancelled = false;

    (async () => {
      const response = await fetch('/api/capture/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostLabel: describeDevice() }),
      });

      const json = await response.json();
      if (cancelled) return;

      if (!response.ok) {
        setError(json.error ?? 'Could not start a capture session.');
        return;
      }

      const raw = json.session as Record<string, unknown>;
      const mapped: CaptureSession = {
        id: raw['id'] as string,
        userId: raw['user_id'] as string,
        code: raw['code'] as string,
        status: raw['status'] as CaptureSession['status'],
        hostLabel: (raw['host_label'] as string) ?? null,
        guestLabel: (raw['guest_label'] as string) ?? null,
        currentItemId: (raw['current_item_id'] as string) ?? null,
        createdAt: raw['created_at'] as string,
        expiresAt: raw['expires_at'] as string,
      };

      setSession(mapped);
      sessionRef.current = mapped;

      const url = pairingUrl(publicEnv.appUrl || window.location.origin, mapped.code);
      setQrDataUrl(
        await QRCode.toDataURL(url, {
          margin: 1,
          width: 320,
          errorCorrectionLevel: 'M',
          color: { dark: '#10130f', light: '#ffffff' },
        }),
      );
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // --- Signed preview URLs --------------------------------------------------
  const loadPreviews = useCallback(async (rows: PhotoRow[]) => {
    const missing = rows.filter((r) => !previews[r.id]).map((r) => r.storage_path);
    if (missing.length === 0) return;

    const { data } = await getSupabaseClient()
      .storage.from('item-photos')
      .createSignedUrls(missing, 3600);

    if (!data) return;
    setPreviews((prev) => {
      const next = { ...prev };
      data.forEach((entry, index) => {
        const row = rows.filter((r) => !prev[r.id])[index];
        if (row && entry.signedUrl) next[row.id] = entry.signedUrl;
      });
      return next;
    });
  }, [previews]);

  // --- Realtime -------------------------------------------------------------
  useEffect(() => {
    if (!session) return;
    const supabase = getSupabaseClient();

    // Catch up on anything shot before this tab subscribed.
    void (async () => {
      const { data } = await supabase
        .from('capture_photos')
        .select('id, storage_path, role, item_id, created_at')
        .eq('session_id', session.id)
        .order('sequence');
      if (data) {
        setPhotos(data as PhotoRow[]);
        void loadPreviews(data as PhotoRow[]);
      }
    })();

    const channel = supabase
      .channel(`capture:${session.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'capture_photos', filter: `session_id=eq.${session.id}` },
        (payload) => {
          const row = payload.new as PhotoRow;
          setPhotos((prev) => {
            const next = prev.some((p) => p.id === row.id)
              ? prev.map((p) => (p.id === row.id ? row : p))
              : [...prev, row];
            void loadPreviews(next);
            return next;
          });
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'capture_sessions', filter: `id=eq.${session.id}` },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          setSession((prev) =>
            prev
              ? {
                  ...prev,
                  status: row['status'] as CaptureSession['status'],
                  guestLabel: (row['guest_label'] as string) ?? null,
                }
              : prev,
          );
        },
      )
      // Items are watched without a session filter because an item created by
      // the phone has no session column — it is linked through its photos.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, (payload) => {
        const item = toItem(payload.new as Record<string, unknown>);
        setItems((prev) => {
          const exists = prev.some((i) => i.id === item.id);
          if (exists) return prev.map((i) => (i.id === item.id ? item : i));
          // Only adopt items created since this session opened, so the tray
          // does not fill with last week's inventory.
          if (new Date(item.createdAt).getTime() < new Date(session.createdAt).getTime()) return prev;
          return [item, ...prev];
        });
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [session, loadPreviews]);

  // --- Render ---------------------------------------------------------------

  if (error) {
    return (
      <div className="max-w-lg">
        <Notice tone="error" title="Capture unavailable">
          {error}
        </Notice>
      </div>
    );
  }

  const loosePhotos = photos.filter((p) => !p.item_id);
  const paired = session?.status === 'paired';

  return (
    <div className="max-w-6xl">
      <header className="mb-6">
        <Eyebrow>Capture</Eyebrow>
        <h1 className="text-3xl font-extrabold">Shoot on your phone, list on your computer</h1>
        <p className="mt-2 max-w-xl text-sm text-mute">
          Photos land here as you take them. Tap &ldquo;Next item&rdquo; on the phone and the AI starts
          researching, pricing and writing while you move on to the next garment.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        {/* Pairing */}
        <Card className="h-fit">
          {onPhone ? (
            <div className="text-center">
              <p className="mb-3 text-sm text-mute">
                You are already on a phone. Open the camera directly.
              </p>
              {session ? (
                <Link href={`/capture/${session.code}`}>
                  <Button full>Open camera</Button>
                </Link>
              ) : null}
            </div>
          ) : (
            <>
              <Eyebrow>{paired ? 'Phone connected' : 'Scan with your phone'}</Eyebrow>

              <div className="mt-3 flex justify-center rounded-lg bg-white p-3">
                {qrDataUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={qrDataUrl} alt="Pairing QR code" width={240} height={240} className="h-auto w-full max-w-[240px]" />
                ) : (
                  <div className="aspect-square w-full max-w-[240px] animate-pulse bg-sunk" />
                )}
              </div>

              <p className="mt-3 text-center font-mono text-2xl font-semibold tracking-[0.22em] text-ink">
                {session?.code ?? '······'}
              </p>

              <p className="mt-2 text-center text-xs text-mute">
                {paired ? (
                  <span className="text-accent">
                    Connected{session?.guestLabel ? ` — ${session.guestLabel}` : ''}
                  </span>
                ) : (
                  <>Or go to {stripProtocol(publicEnv.appUrl)}/capture and type the code</>
                )}
              </p>

              {/* The single most common local-dev failure, called out before it
                  happens rather than after. */}
              {publicEnv.appUrl.includes('localhost') ? (
                <div className="mt-4">
                  <Notice tone="warn" title="Your phone cannot reach localhost">
                    Set <code className="font-mono text-xs">NEXT_PUBLIC_APP_URL</code> to your
                    computer&rsquo;s LAN address and run{' '}
                    <code className="font-mono text-xs">npm run dev:lan</code>. The camera also needs
                    HTTPS, so a tunnel is the quickest route.
                  </Notice>
                </div>
              ) : null}
            </>
          )}
        </Card>

        {/* Live tray */}
        <div className="min-w-0 space-y-6">
          <section>
            <div className="mb-2 flex items-baseline justify-between">
              <Eyebrow>Incoming</Eyebrow>
              <span className="tnum text-xs text-mute">
                {loosePhotos.length} photo{loosePhotos.length === 1 ? '' : 's'} waiting
              </span>
            </div>

            {loosePhotos.length === 0 ? (
              <div className="rounded-xl border border-dashed border-hair px-5 py-10 text-center text-sm text-mute">
                {paired
                  ? 'Phone connected. Take a photo and it appears here.'
                  : 'Waiting for a phone to scan the code.'}
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-6">
                {loosePhotos.map((photo) => (
                  <div key={photo.id} className="relative aspect-square overflow-hidden rounded-lg bg-sunk">
                    {previews[photo.id] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={previews[photo.id]} alt={photo.role} className="h-full w-full object-cover" />
                    ) : (
                      <div className="h-full w-full animate-pulse bg-sunk" />
                    )}
                    <span className="absolute bottom-1 left-1 rounded bg-ink/75 px-1 font-mono text-[8px] uppercase text-paper">
                      {photo.role}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <Eyebrow>Items from this session</Eyebrow>
            {items.length === 0 ? (
              <Empty
                title="Nothing finished yet"
                body="Each time you tap “Next item” on the phone, the photos group into an item and the AI gets to work. It shows up here."
              />
            ) : (
              <ul className="space-y-3">
                {items.map((item) => (
                  <ItemProgressCard key={item.id} item={item} />
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

const STAGE_LABEL: Record<string, string> = {
  pending: 'Queued',
  extracting: 'Reading the photos',
  resolving: 'Finding the product',
  pricing: 'Checking comps',
  writing: 'Writing the listing',
  complete: 'Ready to review',
  failed: 'Failed',
};

const STAGE_ORDER = ['pending', 'extracting', 'resolving', 'pricing', 'writing', 'complete'];

function ItemProgressCard({ item }: { item: Item }) {
  const stageIndex = STAGE_ORDER.indexOf(item.analysisStatus);
  const progress = item.analysisStatus === 'failed' ? 0 : ((stageIndex + 1) / STAGE_ORDER.length) * 100;
  const done = item.analysisStatus === 'complete';

  return (
    <Card as="li">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">
            {item.title ?? `${item.photoPaths.length} photos`}
          </p>
          <p className="mt-0.5 text-xs text-mute">
            {STAGE_LABEL[item.analysisStatus] ?? item.analysisStatus}
            {item.attributes?.brand ? ` · ${item.attributes.brand}` : ''}
            {item.attributes?.size ? ` · size ${item.attributes.size}` : ''}
          </p>
        </div>

        <div className="shrink-0 text-right">
          {item.priceSuggestion ? (
            <p className="font-display text-lg font-bold text-ink">
              <Money cents={item.priceSuggestion.listPriceCents} />
            </p>
          ) : null}
          <StatusPill status={item.status} />
        </div>
      </div>

      {!done && item.analysisStatus !== 'failed' ? (
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-sunk">
          <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${progress}%` }} />
        </div>
      ) : null}

      {item.attributes ? (
        <div className="mt-3">
          <ConfidenceBar value={item.attributes.confidence} />
        </div>
      ) : null}

      {done ? (
        <div className="mt-3">
          <Link href={`/items/${item.id}`}>
            <Button variant="secondary" full>
              Review and publish
            </Button>
          </Link>
        </div>
      ) : null}
    </Card>
  );
}

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//, '');
}
