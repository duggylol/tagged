'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

import { publicEnv } from '../env';

let cached: SupabaseClient | null = null;

/**
 * Browser Supabase client. Singleton, because every new instance opens its own
 * Realtime socket and the capture screen would otherwise burn through the
 * free tier's concurrent connection limit.
 */
export function getSupabaseClient(): SupabaseClient {
  if (cached) return cached;
  cached = createBrowserClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey);
  return cached;
}
