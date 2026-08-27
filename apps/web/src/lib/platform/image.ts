'use client';

/**
 * On-device image processing.
 *
 * Everything here runs in the browser before a byte reaches the network:
 * downscale, compress to WebP, and compute a perceptual hash. That is worth
 * doing carefully, because it is simultaneously the cheapest and the most
 * valuable stage of the pipeline —
 *
 *   • Zero server cost and zero egress.
 *   • A 4MB phone photo becomes ~120KB, so uploads finish over bad thrift-store
 *     signal instead of timing out.
 *   • Fewer image tokens sent to the model, which is most of the per-item cost.
 */

export interface ProcessedImage {
  blob: Blob;
  width: number;
  height: number;
  /** 64-bit difference hash, 16 hex chars. */
  phash: string;
  /** Bytes saved, for the "we compressed this" affordance in the UI. */
  originalBytes: number;
  /**
   * What the encoder ACTUALLY produced — never assume it matches what was
   * requested. See `encodeCompressed`.
   */
  mimeType: string;
  /** File extension matching `mimeType`, for the storage path. */
  extension: string;
}

/** Marketplaces top out well below this; anything larger is wasted bytes. */
const MAX_DIMENSION = 1600;
const WEBP_QUALITY = 0.82;

async function loadBitmap(source: Blob): Promise<ImageBitmap> {
  // `imageOrientation: 'from-image'` matters: phone photos carry EXIF rotation
  // and without it every portrait shot arrives sideways.
  return createImageBitmap(source, { imageOrientation: 'from-image' });
}

function fitWithin(width: number, height: number, max: number) {
  if (width <= max && height <= max) return { width, height };
  const scale = max / Math.max(width, height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function makeCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function canvasToBlob(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob> {
  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type, quality });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image'))),
      type,
      quality,
    );
  });
}

/**
 * Encode, and verify what actually came out.
 *
 * Neither `toBlob` nor `convertToBlob` throws when it cannot encode the type
 * you asked for — per spec they silently fall back to PNG. That failure is
 * invisible and expensive: a 900x1600 PNG runs ~2.2MB where the WebP would be
 * ~150KB, which is a 15x bigger upload over thrift-store signal and a vision
 * call that takes half a minute instead of a few seconds.
 *
 * So: ask for WebP, check what came back, and fall back to JPEG — which every
 * canvas implementation can encode — rather than shipping PNG by accident.
 */
async function encodeCompressed(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  quality: number,
): Promise<{ blob: Blob; mimeType: string; extension: string }> {
  const webp = await canvasToBlob(canvas, 'image/webp', quality);
  if (webp.type === 'image/webp') {
    return { blob: webp, mimeType: 'image/webp', extension: 'webp' };
  }

  const jpeg = await canvasToBlob(canvas, 'image/jpeg', quality);
  if (jpeg.type === 'image/jpeg') {
    return { blob: jpeg, mimeType: 'image/jpeg', extension: 'jpg' };
  }

  // Both fell back. Take the smaller of what we have rather than fail the
  // capture outright — an oversized photo still beats a lost one.
  const best = jpeg.size < webp.size ? jpeg : webp;
  return { blob: best, mimeType: best.type || 'image/png', extension: 'png' };
}

/**
 * Difference hash. Downscale to 9×8 greyscale, then compare each pixel with
 * its right-hand neighbour — 64 bits that survive resizing and recompression
 * but change when the subject does. Used for duplicate detection and for
 * spotting near-identical frames in a batch shoot.
 */
async function computeDHash(bitmap: ImageBitmap): Promise<string> {
  const w = 9;
  const h = 8;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) return '';

  ctx.drawImage(bitmap, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  const grey: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    grey.push(0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!);
  }

  let bits = '';
  for (let row = 0; row < h; row += 1) {
    for (let col = 0; col < w - 1; col += 1) {
      bits += grey[row * w + col]! > grey[row * w + col + 1]! ? '1' : '0';
    }
  }

  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += Number.parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

export async function processImage(file: Blob): Promise<ProcessedImage> {
  const bitmap = await loadBitmap(file);
  const { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_DIMENSION);

  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('Your browser could not process this image.');

  ctx.drawImage(bitmap, 0, 0, width, height);

  const [encoded, phash] = await Promise.all([
    encodeCompressed(canvas, WEBP_QUALITY),
    computeDHash(bitmap),
  ]);

  bitmap.close?.();

  return {
    blob: encoded.blob,
    width,
    height,
    phash,
    originalBytes: file.size,
    mimeType: encoded.mimeType,
    extension: encoded.extension,
  };
}

/**
 * Background removal.
 *
 * Runs entirely in the browser via WASM, so it costs nothing to serve. The
 * model is a several-megabyte download, which is why it is a dynamic import
 * behind an explicit user action rather than something that happens to every
 * photo — and why failure returns the original rather than erroring. A photo
 * with a background is a worse listing; a photo that never uploaded is a lost
 * one.
 */
export async function removeBackground(blob: Blob): Promise<Blob> {
  try {
    const mod = await import('@imgly/background-removal');
    const result = await mod.removeBackground(blob, { output: { format: 'image/png' } });
    return result;
  } catch {
    return blob;
  }
}

export async function isBackgroundRemovalAvailable(): Promise<boolean> {
  try {
    await import('@imgly/background-removal');
    return true;
  } catch {
    return false;
  }
}

/** Data URL for an immediate preview, before the upload finishes. */
export function toObjectUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
