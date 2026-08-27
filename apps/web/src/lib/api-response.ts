import { NextResponse } from 'next/server';

import { UnauthorizedError } from './supabase/server';

/**
 * One error shape for every route.
 *
 * `message` is written to be shown to a person — a seller who sees
 * "Your eBay session expired" can act; one who sees "401" cannot. `action`
 * tells the UI which button to offer.
 */
export interface ApiError {
  error: string;
  action?: 'reconnect' | 'install_extension' | 'open_browser' | 'sign_in' | 'upgrade';
}

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export function fail(message: string, status = 400, action?: ApiError['action']): NextResponse {
  return NextResponse.json({ error: message, ...(action ? { action } : {}) }, { status });
}

/**
 * Turns whatever went wrong into a response a person can act on. Named error
 * types from the packages carry their own guidance, so they survive intact
 * instead of collapsing into "something went wrong".
 */
export function handleError(error: unknown): NextResponse {
  if (error instanceof UnauthorizedError) {
    return fail('You need to be signed in.', 401, 'sign_in');
  }

  if (isNamed(error, 'NotConnectedError')) {
    const action = (error as { action?: ApiError['action'] }).action;
    return fail((error as Error).message, 409, action);
  }

  if (isNamed(error, 'BudgetExceededError')) {
    return fail((error as Error).message, 402, 'upgrade');
  }

  if (isNamed(error, 'AIProviderError') || isNamed(error, 'MarketplaceError')) {
    const retryable = (error as { retryable?: boolean }).retryable === true;
    return fail((error as Error).message, retryable ? 503 : 502);
  }

  if (isNamed(error, 'PipelineError') || isNamed(error, 'InvalidTransitionError')) {
    return fail((error as Error).message, 422);
  }

  const message = error instanceof Error ? error.message : 'Something went wrong.';
  // Log the real thing server-side; the caller gets the readable version.
  console.error('[tagged]', error);
  return fail(message, 500);
}

function isNamed(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

/** Small guard for routes that take a JSON body. */
export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error('Expected a JSON body.');
  }
}
