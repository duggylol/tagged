/**
 * @tagged/core — platform-agnostic domain logic.
 *
 * Nothing in this package imports Node, the DOM, Next.js, or Supabase. That is
 * deliberate: it is what lets the same pricing engine, state machine, and
 * listing adapters run unchanged in the web app today and inside a Capacitor
 * iOS/Android bundle later. Keep it that way — if something here needs
 * `window` or `process`, it belongs in the app's platform layer instead.
 */

export * from './types';
export * from './platforms';
export * from './fees';
export * from './pricing';
export * from './listing-adapters';
export * from './state-machine';
export * from './analytics';
export * from './capture';
