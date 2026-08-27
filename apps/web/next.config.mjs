/**
 * Two build targets from one codebase.
 *
 *   next build                     → the web app, with API routes
 *   BUILD_TARGET=capacitor next build → a static bundle for iOS/Android
 *
 * The static target has no server, so it calls a deployed API instead. That is
 * what NEXT_PUBLIC_API_BASE is for — see src/lib/api.ts. Keeping this switch
 * here (rather than forking the project later) is most of what "keep the code
 * open for a native launch" actually means in practice.
 */

const isCapacitor = process.env.BUILD_TARGET === 'capacitor';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  ...(isCapacitor
    ? {
        output: 'export',
        // No Next image optimizer without a server.
        images: { unoptimized: true },
        // Capacitor serves from the filesystem; directory-style URLs resolve.
        trailingSlash: true,
      }
    : {
        images: {
          remotePatterns: [
            { protocol: 'https', hostname: '*.supabase.co' },
            { protocol: 'https', hostname: '*.r2.dev' },
          ],
        },
      }),

  transpilePackages: ['@tagged/core', '@tagged/ai', '@tagged/marketplaces'],

  eslint: { ignoreDuringBuilds: true },

  async headers() {
    if (isCapacitor) return [];
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // The phone capture screen needs the camera; nothing else does.
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
