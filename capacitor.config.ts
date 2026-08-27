import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor config — the native launch path.
 *
 * Nothing here is active until you run the steps in README.md § Going native.
 * It is committed now because the decisions it encodes had to be made while
 * the web app was being written, not retrofitted afterwards:
 *
 *   • All domain logic lives in packages/core with no DOM or Node imports.
 *   • Anything platform-specific goes through apps/web/src/lib/platform/*.
 *   • `BUILD_TARGET=capacitor` produces a static export (see next.config.mjs).
 *   • The static bundle has no server, so it calls a deployed API — which is
 *     what NEXT_PUBLIC_API_BASE and src/lib/api.ts exist for.
 *
 * The camera work already runs through getUserMedia and a file-capture
 * fallback, both of which Capacitor's WebView supports, so the phone capture
 * screen needs no rewrite. Swapping in @capacitor/camera later is an
 * optimization, not a prerequisite.
 */
const config: CapacitorConfig = {
  appId: 'com.tagged.app',
  appName: 'Tagged',
  webDir: 'apps/web/out',

  server: {
    androidScheme: 'https',
  },

  ios: {
    contentInset: 'always',
    // The capture screen is a viewfinder; rubber-banding it looks broken.
    scrollEnabled: true,
  },

  android: {
    allowMixedContent: false,
  },

  plugins: {
    SplashScreen: {
      launchShowDuration: 600,
      backgroundColor: '#0f120e',
      showSpinner: false,
    },
  },
};

export default config;
