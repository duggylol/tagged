import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

import { publicEnv, serverEnv } from '../env';

/**
 * Request-scoped client that carries the signed-in user's session, so every
 * query runs under Row Level Security. Use this for anything acting on behalf
 * of a user.
 */
export async function getServerSupabase(): Promise<SupabaseClient> {
  const cookieStore = await cookies();

  return createServerClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: Array<{ name: string; value: string; options?: Record<string, unknown> }>) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // Middleware refreshes the session, so this is safe to ignore.
        }
      },
    },
  });
}

/**
 * Service-role client. Bypasses RLS entirely.
 *
 * Only for work that genuinely cannot run as a user: writing anonymized rows
 * to the shared `comps` table, and the cron sale-detection sweep which acts
 * across all accounts. Every use must scope by user_id by hand, because the
 * database will no longer do it for you.
 */
export function getAdminSupabase(): SupabaseClient {
  const env = serverEnv();
  return createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** The signed-in user, or null. */
export async function getCurrentUser() {
  const supabase = await getServerSupabase();
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user;
}

export class UnauthorizedError extends Error {
  constructor() {
    super('You need to be signed in.');
    this.name = 'UnauthorizedError';
  }
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}
