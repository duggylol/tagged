/**
 * @tagged/marketplaces — one interface over every selling channel.
 *
 * The orchestration layer never branches on "is this eBay or Poshmark". It
 * asks the registry for an adapter and calls `publish` / `end` / `fetchSold`.
 * That is what makes the sixth marketplace a single new file rather than an
 * integration project.
 */

export * from './adapter';
export * from './extension';
export { EbayAdapter, EBAY_SCOPES, skuForItem } from './ebay';
export type { EbayConfig, EbayTokens, EbayEnv } from './ebay';
export { EtsyAdapter, ETSY_SCOPES } from './etsy';
export type { EtsyConfig, EtsyTokens } from './etsy';

import type { PlatformId } from '@tagged/core';
import { getPlatform } from '@tagged/core';

import type { MarketplaceAdapter } from './adapter';
import { EbayAdapter } from './ebay';
import { EtsyAdapter } from './etsy';
import { ExtensionAdapter } from './extension';
import type { ExtensionQueue } from './extension';

export interface RegistryConfig {
  userId: string;
  extensionQueue: ExtensionQueue;
  ebay?: { clientId: string; clientSecret: string; redirectUri: string; env?: 'sandbox' | 'production' };
  etsy?: { clientId: string; clientSecret: string; redirectUri: string };
}

/**
 * Build the adapter for a platform.
 *
 * Extension-backed platforms need no configuration beyond the queue, which is
 * why Poshmark and Mercari work on day one while eBay waits on API approval.
 */
export function getAdapter(platform: PlatformId, config: RegistryConfig): MarketplaceAdapter {
  const spec = getPlatform(platform);

  if (spec.connection === 'extension') {
    return new ExtensionAdapter(platform, config.extensionQueue, config.userId);
  }

  switch (platform) {
    case 'ebay': {
      if (!config.ebay?.clientId) {
        throw new Error('eBay is not configured. Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET.');
      }
      return new EbayAdapter(config.ebay);
    }
    case 'etsy': {
      if (!config.etsy?.clientId) {
        throw new Error('Etsy is not configured. Set ETSY_CLIENT_ID and ETSY_CLIENT_SECRET.');
      }
      return new EtsyAdapter(config.etsy);
    }
    default:
      throw new Error(`No adapter implemented for ${platform} yet.`);
  }
}
