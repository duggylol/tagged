import { publicEnv } from './env';

/**
 * Where the API lives.
 *
 * In the web build the app and its API routes are the same origin, so this is
 * a no-op. In a Capacitor build there is no server inside the bundle — the app
 * is static files loaded from the device — so every call has to go to a
 * deployed origin. Routing all fetches through here is what keeps the two
 * builds identical everywhere else.
 */
export function apiUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  if (!publicEnv.apiBase) return normalized;
  return `${publicEnv.apiBase.replace(/\/+$/, '')}${normalized}`;
}

export interface ApiFailure {
  error: string;
  action?: 'reconnect' | 'install_extension' | 'open_browser' | 'sign_in' | 'upgrade';
}

/**
 * fetch + JSON + a readable error.
 *
 * `credentials: 'include'` matters for the native build, where the app origin
 * differs from the API origin and cookies are not sent by default.
 */
export async function apiCall<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method: init.method ?? 'GET',
    headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'include',
  });

  const json = (await response.json().catch(() => ({}))) as T & Partial<ApiFailure>;

  if (!response.ok) {
    const error = new Error(json.error ?? `Request failed (${response.status}).`);
    error.name = 'ApiError';
    (error as Error & ApiFailure).action = json.action;
    throw error;
  }

  return json as T;
}
