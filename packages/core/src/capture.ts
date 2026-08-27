import type { CapturePhoto, PhotoRole } from './types';

/**
 * Phone ↔ PC capture pairing.
 *
 * The desktop opens a session and renders a QR. The phone scans it, joins, and
 * starts pushing photos straight to storage; the desktop watches the same rows
 * over Realtime and reacts as they land. This module holds the parts that must
 * behave identically on both ends.
 */

/**
 * Deliberately excludes 0/O/1/I/L — someone will type this off a screen across
 * the room, and those are the characters they will get wrong.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 6;

/** Pairing codes are short-lived; a stale QR left on a monitor is a real risk. */
export const SESSION_TTL_MINUTES = 30;

export function generatePairingCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  }
  return code;
}

export function normalizePairingCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .slice(0, CODE_LENGTH);
}

export function isValidPairingCode(input: string): boolean {
  const normalized = input.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (normalized.length !== CODE_LENGTH) return false;
  return [...normalized].every((ch) => CODE_ALPHABET.includes(ch));
}

export function pairingUrl(appUrl: string, code: string): string {
  return `${appUrl.replace(/\/+$/, '')}/capture/${code}`;
}

// ---------------------------------------------------------------------------
// Photo grouping
// ---------------------------------------------------------------------------

/**
 * A gap longer than this between shots almost always means the seller moved on
 * to the next garment. Used as the fallback when they do not tap "Next item".
 */
export const AUTO_GROUP_GAP_SECONDS = 45;

export interface PhotoGroup {
  /** Null until the group is committed to an item. */
  itemId: string | null;
  photos: CapturePhoto[];
  /** True when the group has a care-tag shot — materially better extraction. */
  hasTagShot: boolean;
  startedAt: string;
}

/**
 * Split a session's photo stream into per-item groups.
 *
 * Explicit item boundaries (the phone tapping "Next item", which stamps an
 * itemId) always win. The time-gap heuristic only fills in for photos the
 * seller never assigned, so a deliberate grouping is never overridden by a
 * guess.
 */
export function groupPhotos(
  photos: CapturePhoto[],
  gapSeconds = AUTO_GROUP_GAP_SECONDS,
): PhotoGroup[] {
  const ordered = [...photos].sort((a, b) => a.sequence - b.sequence);
  const groups: PhotoGroup[] = [];
  let current: PhotoGroup | null = null;
  let lastAt = 0;

  for (const photo of ordered) {
    const at = new Date(photo.createdAt).getTime();
    const gapExceeded = current !== null && Number.isFinite(at) && Number.isFinite(lastAt)
      ? (at - lastAt) / 1000 > gapSeconds
      : false;

    const itemChanged =
      current !== null && photo.itemId !== null && current.itemId !== null && photo.itemId !== current.itemId;

    const startNew =
      current === null || itemChanged || (photo.itemId === null && current.itemId === null && gapExceeded);

    if (startNew) {
      current = {
        itemId: photo.itemId,
        photos: [],
        hasTagShot: false,
        startedAt: photo.createdAt,
      };
      groups.push(current);
    } else if (current!.itemId === null && photo.itemId !== null) {
      // The seller assigned the group mid-stream; adopt it.
      current!.itemId = photo.itemId;
    }

    current!.photos.push(photo);
    if (photo.role === 'tag') current!.hasTagShot = true;
    if (Number.isFinite(at)) lastAt = at;
  }

  return groups;
}

/**
 * Which photos to actually send to the vision model, and in what order.
 *
 * Sending every shot is wasteful — most are near-duplicates. Four well-chosen
 * images cost about a twentieth of a cent and outperform twelve, and the care
 * tag is the single highest-signal frame in the whole app: a style number
 * turns a guess into a lookup.
 */
export function selectPhotosForAnalysis(photos: CapturePhoto[], max = 4): CapturePhoto[] {
  const byRole = (role: PhotoRole) => photos.filter((p) => p.role === role);
  const picked: CapturePhoto[] = [];
  const seen = new Set<string>();

  const take = (candidates: CapturePhoto[], count: number) => {
    for (const photo of candidates) {
      if (picked.length >= max || count <= 0) return;
      if (seen.has(photo.id)) continue;
      seen.add(photo.id);
      picked.push(photo);
      count -= 1;
    }
  };

  take(byRole('tag'), 1);      // brand, size, fabric, style number, RN
  take(byRole('front'), 1);    // the silhouette
  take(byRole('defect'), 1);   // honest condition disclosure
  take(byRole('back'), 1);
  take(byRole('detail'), 1);
  take(photos, max - picked.length); // fill from whatever is left

  return picked.slice(0, max);
}

/** What the phone should ask for next, so extraction has what it needs. */
export function nextShotPrompt(group: PhotoGroup): string | null {
  const roles = new Set(group.photos.map((p) => p.role));
  if (!roles.has('front')) return 'Front of the item, flat and square to the camera';
  if (!roles.has('tag')) return 'The care tag — brand, size and fabric all in frame';
  if (!roles.has('back')) return 'Back of the item';
  if (group.photos.length < 4) return 'A close-up of any flaw, or a detail worth showing';
  return null;
}

/**
 * Hamming distance between two hex perceptual hashes. Used for duplicate
 * detection — catching a seller about to relist something already sold — and
 * for grouping near-identical frames.
 */
export function phashDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = Number.parseInt(a[i]!, 16);
    const y = Number.parseInt(b[i]!, 16);
    if (Number.isNaN(x) || Number.isNaN(y)) return Number.MAX_SAFE_INTEGER;
    let diff = x ^ y;
    while (diff) {
      distance += diff & 1;
      diff >>= 1;
    }
  }
  return distance;
}

/** Below this, two photos are the same garment. Tuned for a 64-bit dHash. */
export const DUPLICATE_PHASH_THRESHOLD = 8;

export function isLikelyDuplicate(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return phashDistance(a, b) <= DUPLICATE_PHASH_THRESHOLD;
}
