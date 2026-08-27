'use client';

import {
  nextShotPrompt,
  type PhotoRole,
  type PhotoGroup,
  type CapturePhoto,
} from '@tagged/core';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, Notice } from '@/components/ui';
import {
  cameraBlockedByInsecureContext,
  describeDevice,
  hasCameraStream,
  requestWakeLock,
  tapFeedback,
} from '@/lib/platform/capabilities';
import { processImage } from '@/lib/platform/image';
import { getSupabaseClient } from '@/lib/supabase/client';

/**
 * The phone camera.
 *
 * This is the screen a reseller actually uses: standing up, one hand holding a
 * garment, in a room with bad light and worse signal. Everything about it is
 * shaped by that — big targets, no scrolling to reach the shutter, a wake lock
 * so the screen does not sleep between shots, and haptic confirmation so they
 * do not have to look at the screen to know a photo landed.
 *
 * Photos go straight from here to storage. The desktop is watching the same
 * rows over Realtime, so they appear there within a second without either
 * device polling.
 */

const ROLES: Array<{ id: PhotoRole; label: string; hint: string }> = [
  { id: 'front', label: 'Front', hint: 'Flat and square to the camera' },
  { id: 'tag', label: 'Care tag', hint: 'Brand, size and fabric in frame' },
  { id: 'back', label: 'Back', hint: '' },
  { id: 'detail', label: 'Detail', hint: '' },
  { id: 'defect', label: 'Flaw', hint: 'Get close — disclosing beats a return' },
];

interface PendingPhoto {
  id: string;
  previewUrl: string;
  role: PhotoRole;
  uploading: boolean;
  error?: string;
}

export default function PhoneCapturePage() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const code = (params.code ?? '').toUpperCase();

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sequenceRef = useRef(0);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [phase, setPhase] = useState<'joining' | 'ready' | 'error'>('joining');
  const [error, setError] = useState<string | null>(null);
  const [cameraLive, setCameraLive] = useState(false);

  const [role, setRole] = useState<PhotoRole>('front');
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [itemsDone, setItemsDone] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const [notes, setNotes] = useState('');
  const [showNotes, setShowNotes] = useState(false);

  // --- Join -----------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const supabase = getSupabaseClient();
      const { data: auth } = await supabase.auth.getUser();

      if (!auth.user) {
        router.replace(`/login?next=/capture/${code}`);
        return;
      }
      if (cancelled) return;
      setUserId(auth.user.id);

      const response = await fetch('/api/capture/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, guestLabel: describeDevice() }),
      });

      const json = await response.json();
      if (cancelled) return;

      if (!response.ok) {
        setError(json.error ?? 'Could not join that session.');
        setPhase('error');
        return;
      }

      setSessionId(json.session.id);
      setPhase('ready');
    })();

    return () => {
      cancelled = true;
    };
  }, [code, router]);

  // --- Camera ---------------------------------------------------------------
  useEffect(() => {
    if (phase !== 'ready') return;
    let releaseWakeLock: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      if (!hasCameraStream()) return;

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setCameraLive(true);
        releaseWakeLock = await requestWakeLock();
      } catch {
        // Permission denied or no camera. The file-picker fallback still works,
        // so this is a downgrade rather than a failure.
        setCameraLive(false);
      }
    })();

    return () => {
      cancelled = true;
      releaseWakeLock?.();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [phase]);

  // --- Upload ---------------------------------------------------------------
  const upload = useCallback(
    async (blob: Blob, photoRole: PhotoRole) => {
      if (!sessionId || !userId) return;

      const localId = crypto.randomUUID();
      const previewUrl = URL.createObjectURL(blob);
      setPhotos((prev) => [...prev, { id: localId, previewUrl, role: photoRole, uploading: true }]);

      try {
        // Stage 0 runs here: downscale, WebP, perceptual hash. A 4MB phone
        // photo becomes ~120KB, which is the difference between an upload that
        // finishes on thrift-store signal and one that times out.
        const processed = await processImage(blob);
        const supabase = getSupabaseClient();
        // Use the extension and content type the encoder actually produced.
        // Hardcoding webp here recorded the wrong type for browsers that
        // silently fall back, and hid a 15x size regression.
        const path = `${userId}/${sessionId}/${localId}.${processed.extension}`;

        const { error: uploadError } = await supabase.storage
          .from('item-photos')
          .upload(path, processed.blob, { contentType: processed.mimeType, upsert: false });

        if (uploadError) throw new Error(uploadError.message);

        sequenceRef.current += 1;
        const { data, error: insertError } = await supabase
          .from('capture_photos')
          .insert({
            session_id: sessionId,
            user_id: userId,
            storage_path: path,
            phash: processed.phash,
            width: processed.width,
            height: processed.height,
            sequence: sequenceRef.current,
            role: photoRole,
          })
          .select('id')
          .single();

        if (insertError) throw new Error(insertError.message);

        setPhotos((prev) =>
          prev.map((p) => (p.id === localId ? { ...p, id: data.id as string, uploading: false } : p)),
        );
        tapFeedback(12);
      } catch (cause) {
        setPhotos((prev) =>
          prev.map((p) =>
            p.id === localId
              ? {
                  ...p,
                  uploading: false,
                  error: cause instanceof Error ? cause.message : 'Upload failed',
                }
              : p,
          ),
        );
      }
    },
    [sessionId, userId],
  );

  const shoot = useCallback(async () => {
    const video = videoRef.current;
    if (!cameraLive || !video) {
      fileInputRef.current?.click();
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (blob) void upload(blob, role);
      },
      'image/jpeg',
      0.92,
    );

    // Advance to whatever is still missing, so the seller does not have to
    // think about the role picker between shots.
    const group = asGroup(photos, role);
    const nextRole = suggestNextRole(group);
    if (nextRole) setRole(nextRole);
  }, [cameraLive, role, upload, photos]);

  // --- Finish item ----------------------------------------------------------
  async function finishItem() {
    const uploaded = photos.filter((p) => !p.uploading && !p.error);
    if (uploaded.length === 0 || !sessionId) return;

    setFinishing(true);
    try {
      const response = await fetch('/api/capture/finish-item', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          photoIds: uploaded.map((p) => p.id),
          sellerNotes: notes.trim() || undefined,
        }),
      });

      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? 'Could not save that item.');

      photos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
      setPhotos([]);
      setNotes('');
      setShowNotes(false);
      setRole('front');
      setItemsDone((n) => n + 1);
      tapFeedback([18, 60, 18]);

      if (json.duplicate) {
        setError(
          `Heads up — this looks like "${json.duplicate.title ?? 'an item'}" you already have (${json.duplicate.status}).`,
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save that item.');
    } finally {
      setFinishing(false);
    }
  }

  // --- Render ---------------------------------------------------------------

  if (phase === 'joining') {
    return <Centered>Pairing with your computer…</Centered>;
  }

  if (phase === 'error') {
    return (
      <Centered>
        <div className="max-w-xs space-y-4 text-center">
          <Notice tone="error" title="Could not pair">
            {error}
          </Notice>
          <Button variant="secondary" onClick={() => router.push('/capture')} full>
            Open Capture here instead
          </Button>
        </div>
      </Centered>
    );
  }

  const uploadedCount = photos.filter((p) => !p.uploading && !p.error).length;
  const group = asGroup(photos, role);
  const prompt = nextShotPrompt(group);

  return (
    <div className="no-bounce flex h-dvh flex-col bg-ink text-paper">
      {/* Viewfinder */}
      <div className="relative flex-1 overflow-hidden bg-black">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="h-full w-full object-cover"
          aria-label="Camera viewfinder"
        />

        {!cameraLive ? (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
            <div className="max-w-xs text-sm text-paper/70">
              {cameraBlockedByInsecureContext() ? (
                <>
                  <p className="mb-2 font-semibold text-paper">The camera needs a secure connection</p>
                  <p>
                    Browsers block the camera on plain HTTP. Use the tunnel URL from{' '}
                    <span className="font-mono text-xs">npx localtunnel</span>, or deploy, then scan
                    again. You can still pick photos from your gallery below.
                  </p>
                </>
              ) : (
                <p>Camera unavailable — tap the shutter to pick photos from your gallery instead.</p>
              )}
            </div>
          </div>
        ) : null}

        {/* Session badge */}
        <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/55 px-3 py-1.5 backdrop-blur">
          <span className="h-2 w-2 rounded-full bg-[--color-accent] pulse-ring" />
          <span className="font-mono text-[11px] tracking-wider">
            {code} · {itemsDone} item{itemsDone === 1 ? '' : 's'} sent
          </span>
        </div>

        {prompt ? (
          <div className="absolute inset-x-3 top-14 rounded-lg bg-black/55 px-3 py-2 backdrop-blur">
            <p className="text-center text-sm">
              <span className="opacity-60">Next: </span>
              {prompt}
            </p>
          </div>
        ) : null}

        {error ? (
          <button
            type="button"
            onClick={() => setError(null)}
            className="absolute inset-x-3 bottom-3 rounded-lg bg-[--color-amber] px-3 py-2 text-left text-xs text-black"
          >
            {error} <span className="opacity-70">· tap to dismiss</span>
          </button>
        ) : null}
      </div>

      {/* Photo strip */}
      {photos.length > 0 ? (
        <div className="flex gap-2 overflow-x-auto border-t border-white/10 px-3 py-2">
          {photos.map((photo) => (
            <div key={photo.id} className="relative shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={photo.previewUrl}
                alt={photo.role}
                className={`h-16 w-16 rounded-lg object-cover ${photo.uploading ? 'opacity-40' : ''} ${
                  photo.error ? 'ring-2 ring-[--color-rust]' : ''
                }`}
              />
              <span className="absolute bottom-0.5 left-0.5 rounded bg-black/70 px-1 font-mono text-[8px] uppercase">
                {photo.role}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* Controls */}
      <div className="border-t border-white/10 px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-3">
        <div className="mb-3 flex gap-1.5 overflow-x-auto">
          {ROLES.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setRole(option.id)}
              aria-pressed={role === option.id}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                role === option.id ? 'bg-paper text-ink' : 'bg-white/10 text-paper/70'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        {showNotes ? (
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Anything the camera can't see — what you paid, a flaw, the brand if the tag is gone…"
            rows={2}
            className="mb-3 w-full rounded-lg bg-white/10 px-3 py-2 text-sm text-paper placeholder:text-paper/40 focus:outline-none"
          />
        ) : null}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowNotes((v) => !v)}
            className={`h-12 w-12 shrink-0 rounded-full text-xs font-medium ${
              notes ? 'bg-[--color-accent] text-paper' : 'bg-white/10 text-paper/70'
            }`}
            aria-label="Add a note"
          >
            Note
          </button>

          <button
            type="button"
            onClick={shoot}
            className="h-16 flex-1 rounded-full bg-paper text-base font-semibold text-ink active:scale-[0.98]"
          >
            Shoot
          </button>

          <button
            type="button"
            onClick={finishItem}
            disabled={uploadedCount === 0 || finishing}
            className="h-12 shrink-0 rounded-full bg-[--color-accent] px-4 text-xs font-semibold text-paper disabled:opacity-30"
          >
            {finishing ? 'Sending…' : 'Next item'}
          </button>
        </div>

        <p className="mt-2 text-center text-[11px] text-paper/40">
          {uploadedCount > 0
            ? `${uploadedCount} photo${uploadedCount === 1 ? '' : 's'} ready — "Next item" sends them to your computer`
            : 'Photos appear on your computer as you shoot'}
        </p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          files.forEach((file) => void upload(file, role));
          event.target.value = '';
        }}
      />
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-dvh items-center justify-center p-6 text-sm text-mute">{children}</div>;
}

/** Adapt the local pending list to the shape `nextShotPrompt` expects. */
function asGroup(photos: PendingPhoto[], _role: PhotoRole): PhotoGroup {
  return {
    itemId: null,
    hasTagShot: photos.some((p) => p.role === 'tag'),
    startedAt: new Date(0).toISOString(),
    photos: photos.map(
      (p, index): CapturePhoto => ({
        id: p.id,
        sessionId: '',
        userId: '',
        itemId: null,
        storagePath: '',
        phash: null,
        width: null,
        height: null,
        sequence: index,
        role: p.role,
        createdAt: new Date(0).toISOString(),
      }),
    ),
  };
}

function suggestNextRole(group: PhotoGroup): PhotoRole | null {
  const roles = new Set(group.photos.map((p) => p.role));
  if (!roles.has('front')) return 'front';
  if (!roles.has('tag')) return 'tag';
  if (!roles.has('back')) return 'back';
  return 'detail';
}
