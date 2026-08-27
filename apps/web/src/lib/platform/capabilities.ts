'use client';

/**
 * The platform capability layer.
 *
 * Everything that differs between a browser tab and a Capacitor native shell
 * is detected here and nowhere else. When you run `npx cap add ios`, this is
 * the only file that needs new branches — the rest of the app asks these
 * functions rather than sniffing for `window`.
 */

export type Runtime = 'web' | 'ios' | 'android';

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

function capacitor(): CapacitorGlobal | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

export function getRuntime(): Runtime {
  const cap = capacitor();
  if (!cap?.isNativePlatform?.()) return 'web';
  const platform = cap.getPlatform?.();
  return platform === 'ios' ? 'ios' : platform === 'android' ? 'android' : 'web';
}

export function isNative(): boolean {
  return getRuntime() !== 'web';
}

export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

/**
 * "Is this the phone or the desktop?" drives real behaviour, not just
 * styling — the desktop opens capture sessions and the phone joins them.
 */
export function isPhoneFormFactor(): boolean {
  if (typeof window === 'undefined') return false;
  if (isNative()) return true;
  return isTouchDevice() && window.innerWidth < 900;
}

/** True when we can open a live camera stream rather than a file picker. */
export function hasCameraStream(): boolean {
  if (typeof navigator === 'undefined') return false;
  return typeof navigator.mediaDevices?.getUserMedia === 'function';
}

/**
 * Secure context check. `getUserMedia` is blocked on plain HTTP except on
 * localhost — which is exactly the trap you hit the first time you open the
 * dev server on your phone over the LAN.
 */
export function cameraBlockedByInsecureContext(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.isSecureContext) return false;
  return !['localhost', '127.0.0.1'].includes(window.location.hostname);
}

/** A short human label for the pairing UI: "Chrome on Windows", "iPhone". */
export function describeDevice(): string {
  if (typeof navigator === 'undefined') return 'Unknown device';

  const runtime = getRuntime();
  if (runtime === 'ios') return 'iPhone app';
  if (runtime === 'android') return 'Android app';

  const ua = navigator.userAgent;
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : /Firefox\//.test(ua) ? 'Firefox'
    : 'Browser';

  const os =
    /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'macOS'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Linux/.test(ua) ? 'Linux'
    : '';

  return os ? `${browser} on ${os}` : browser;
}

export function supportsVibration(): boolean {
  return typeof navigator !== 'undefined' && 'vibrate' in navigator;
}

/** Confirmation you can feel without looking — useful mid-photo-shoot. */
export function tapFeedback(pattern: number | number[] = 12): void {
  if (supportsVibration()) navigator.vibrate(pattern);
}

/** Keeps the phone awake while it is being used as a camera. */
export async function requestWakeLock(): Promise<() => void> {
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) {
    return () => {};
  }
  try {
    const sentinel = await (
      navigator as Navigator & { wakeLock: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }
    ).wakeLock.request('screen');
    return () => void sentinel.release().catch(() => {});
  } catch {
    return () => {};
  }
}
