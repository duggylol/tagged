/**
 * Environment access, in one place.
 *
 * Server-only values are read through `serverEnv()` which throws on the client
 * — a service-role key that leaks into a bundle is the kind of mistake you
 * only make once, and a loud failure at build time is much cheaper than
 * finding out from a stranger.
 */

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to apps/web/.env.local and fill it in.`,
    );
  }
  return value;
}

export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
  apiBase: process.env.NEXT_PUBLIC_API_BASE ?? '',
};

export function assertPublicEnv(): void {
  required('NEXT_PUBLIC_SUPABASE_URL', publicEnv.supabaseUrl);
  required('NEXT_PUBLIC_SUPABASE_ANON_KEY', publicEnv.supabaseAnonKey);
}

export function serverEnv() {
  if (typeof window !== 'undefined') {
    throw new Error('serverEnv() was called in the browser. This would leak secrets.');
  }

  return {
    supabaseUrl: required('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY),

    geminiApiKey: process.env.GEMINI_API_KEY ?? '',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    visionProvider: (process.env.AI_VISION_PROVIDER ?? 'gemini') as 'gemini' | 'anthropic',
    copyProvider: (process.env.AI_COPY_PROVIDER ?? 'gemini') as 'gemini' | 'anthropic',
    visionModel: process.env.AI_VISION_MODEL || undefined,
    copyModel: process.env.AI_COPY_MODEL || undefined,
    premiumCopyModel: process.env.AI_PREMIUM_COPY_MODEL || undefined,
    monthlyBudgetUsd: Number.parseFloat(process.env.AI_MONTHLY_BUDGET_USD ?? '2') || 2,

    ebay: process.env.EBAY_CLIENT_ID
      ? {
          clientId: process.env.EBAY_CLIENT_ID,
          clientSecret: process.env.EBAY_CLIENT_SECRET ?? '',
          redirectUri: process.env.EBAY_REDIRECT_URI ?? '',
          env: (process.env.EBAY_ENV ?? 'sandbox') as 'sandbox' | 'production',
        }
      : undefined,

    etsy: process.env.ETSY_CLIENT_ID
      ? {
          clientId: process.env.ETSY_CLIENT_ID,
          clientSecret: process.env.ETSY_CLIENT_SECRET ?? '',
          redirectUri: process.env.ETSY_REDIRECT_URI ?? '',
        }
      : undefined,

    extensionSecret: process.env.EXTENSION_SHARED_SECRET ?? '',
    cronSecret: process.env.CRON_SECRET ?? '',
  };
}

export type ServerEnv = ReturnType<typeof serverEnv>;
