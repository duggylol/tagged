import type { Comp, PlatformListing } from '@tagged/core';

import {
  buildSearchQuery,
  MarketplaceError,
  NotConnectedError,
  toCents,
} from './adapter';
import type {
  AdapterCredentials,
  CompQuery,
  EndInput,
  MarketplaceAdapter,
  PublishInput,
  PublishResult,
  SoldItem,
} from './adapter';

/**
 * eBay.
 *
 * The anchor platform: a real self-serve API, order webhooks, and a Browse
 * endpoint we can legitimately use for comps.
 *
 * Note what is NOT here: sold-listing history. eBay's Marketplace Insights API
 * is a Limited Release closed to new developers — they monetize that data as
 * Terapeak. `searchComps` therefore returns ACTIVE listings, which are asking
 * prices rather than sale prices. The pricing engine weights them accordingly
 * (see pricing.ts) and leans on our own accumulated sold data instead.
 */

const HOSTS = {
  production: { api: 'https://api.ebay.com', auth: 'https://auth.ebay.com' },
  sandbox: { api: 'https://api.sandbox.ebay.com', auth: 'https://auth.sandbox.ebay.com' },
} as const;

export type EbayEnv = keyof typeof HOSTS;

export const EBAY_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
];

export interface EbayConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  env?: EbayEnv;
  fetchImpl?: typeof fetch;
}

export interface EbayTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export class EbayAdapter implements MarketplaceAdapter {
  readonly platform = 'ebay' as const;

  private readonly config: Required<Omit<EbayConfig, 'fetchImpl'>>;
  private readonly fetchImpl: typeof fetch;

  constructor(config: EbayConfig) {
    this.config = {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
      env: config.env ?? 'sandbox',
    };
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private get hosts() {
    return HOSTS[this.config.env];
  }

  // -------------------------------------------------------------------------
  // OAuth
  // -------------------------------------------------------------------------

  /** Where to send the seller to grant access. `state` must be verified on return. */
  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: 'code',
      redirect_uri: this.config.redirectUri,
      scope: EBAY_SCOPES.join(' '),
      state,
    });
    return `${this.hosts.auth}/oauth2/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<EbayTokens> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
    });
  }

  async refresh(refreshToken: string): Promise<EbayTokens> {
    const tokens = await this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: EBAY_SCOPES.join(' '),
    });
    // A refresh response does not return a new refresh token; keep the old one.
    return { ...tokens, refreshToken: tokens.refreshToken || refreshToken };
  }

  private async tokenRequest(body: Record<string, string>): Promise<EbayTokens> {
    const basic = base64(`${this.config.clientId}:${this.config.clientSecret}`);
    const response = await this.fetchImpl(`${this.hosts.api}/identity/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams(body).toString(),
    });

    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new MarketplaceError(
        'ebay',
        `eBay token request failed: ${String(json['error_description'] ?? response.status)}`,
        response.status,
      );
    }

    const expiresIn = Number(json['expires_in'] ?? 7200);
    return {
      accessToken: String(json['access_token'] ?? ''),
      refreshToken: String(json['refresh_token'] ?? ''),
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Listing lifecycle
  // -------------------------------------------------------------------------

  /**
   * eBay's Inventory API is a three-step publish: describe the inventory item,
   * create an offer against it, then publish the offer. The offer needs
   * business policy ids and a merchant location, which the seller configures
   * once in Seller Hub — we read them during account connect and store them in
   * `creds.meta`.
   */
  async publish(input: PublishInput, creds: AdapterCredentials): Promise<PublishResult> {
    const token = this.requireToken(creds);
    const warnings = [...input.listing.warnings];

    const policies = this.requirePolicies(creds);

    // Step 1 — inventory item (idempotent by SKU; PUT is a full replace).
    await this.request(
      `/sell/inventory/v1/inventory_item/${encodeURIComponent(input.sku)}`,
      {
        method: 'PUT',
        token,
        body: {
          availability: { shipToLocationAvailability: { quantity: 1 } },
          condition: mapCondition(input.listing.attributes['Condition']),
          product: {
            title: input.listing.title,
            description: toHtml(input.listing.description),
            imageUrls: input.imageUrls.slice(0, 24),
            aspects: toAspects(input.listing.attributes),
            ...(input.listing.attributes['MPN'] ? { mpn: input.listing.attributes['MPN'] } : {}),
            ...(input.listing.attributes['Brand'] ? { brand: input.listing.attributes['Brand'] } : {}),
          },
        },
      },
    );

    // Step 2 — offer. Reuse an existing offer for this SKU if one exists,
    // which is what makes a retry safe rather than duplicating the listing.
    let offerId = await this.findExistingOffer(input.sku, token);

    if (!offerId) {
      const created = await this.request<{ offerId?: string }>('/sell/inventory/v1/offer', {
        method: 'POST',
        token,
        idempotencyKey: input.idempotencyKey,
        body: {
          sku: input.sku,
          marketplaceId: 'EBAY_US',
          format: 'FIXED_PRICE',
          availableQuantity: 1,
          categoryId: creds.meta?.['defaultCategoryId'] ?? '11450', // Clothing, Shoes & Accessories
          listingDescription: toHtml(input.listing.description),
          listingPolicies: {
            fulfillmentPolicyId: policies.fulfillmentPolicyId,
            paymentPolicyId: policies.paymentPolicyId,
            returnPolicyId: policies.returnPolicyId,
          },
          pricingSummary: {
            price: { currency: 'USD', value: (input.listing.priceCents / 100).toFixed(2) },
          },
          merchantLocationKey: policies.merchantLocationKey,
        },
      });
      offerId = created.offerId ?? null;
    } else {
      // Retry path: make sure the price matches what we intend to publish.
      await this.request(`/sell/inventory/v1/offer/${offerId}`, {
        method: 'PUT',
        token,
        body: {
          availableQuantity: 1,
          pricingSummary: {
            price: { currency: 'USD', value: (input.listing.priceCents / 100).toFixed(2) },
          },
        },
      });
      warnings.push('Reused the existing eBay offer for this item rather than creating a duplicate.');
    }

    if (!offerId) {
      throw new MarketplaceError('ebay', 'eBay did not return an offer id.', undefined, true);
    }

    // Step 3 — publish.
    const published = await this.request<{ listingId?: string }>(
      `/sell/inventory/v1/offer/${offerId}/publish`,
      { method: 'POST', token, body: {} },
    );

    const listingId = published.listingId ?? offerId;
    return {
      externalId: listingId,
      externalUrl: published.listingId ? `https://www.ebay.com/itm/${published.listingId}` : null,
      warnings,
    };
  }

  async end(input: EndInput, creds: AdapterCredentials): Promise<void> {
    const token = this.requireToken(creds);
    try {
      await this.request(`/sell/inventory/v1/offer/${input.externalId}/withdraw`, {
        method: 'POST',
        token,
        body: {},
      });
    } catch (error) {
      // Already ended is the desired end state, not a failure. Delisting runs
      // on retry loops and must converge rather than alarm.
      if (error instanceof MarketplaceError && error.status === 404) return;
      if (error instanceof MarketplaceError && /not published|already/i.test(error.message)) return;
      throw error;
    }
  }

  async updatePrice(externalId: string, priceCents: number, creds: AdapterCredentials): Promise<void> {
    const token = this.requireToken(creds);
    await this.request(`/sell/inventory/v1/offer/${externalId}`, {
      method: 'PUT',
      token,
      body: {
        availableQuantity: 1,
        pricingSummary: { price: { currency: 'USD', value: (priceCents / 100).toFixed(2) } },
      },
    });
  }

  async fetchSold(since: Date, creds: AdapterCredentials): Promise<SoldItem[]> {
    const token = this.requireToken(creds);
    const filter = `creationdate:[${since.toISOString()}..]`;
    const data = await this.request<EbayOrdersResponse>(
      `/sell/fulfillment/v1/order?filter=${encodeURIComponent(filter)}&limit=100`,
      { method: 'GET', token },
    );

    const sold: SoldItem[] = [];
    for (const order of data.orders ?? []) {
      for (const lineItem of order.lineItems ?? []) {
        sold.push({
          externalId: lineItem.legacyItemId ?? lineItem.lineItemId ?? '',
          externalOrderId: order.orderId ?? '',
          salePriceCents: toCents(lineItem.total?.value),
          feesCents: null, // eBay reports fees on a separate settlement cycle
          soldAt: order.creationDate ?? new Date().toISOString(),
          buyerHandle: order.buyer?.username ?? null,
        });
      }
    }
    return sold.filter((s) => s.externalId);
  }

  /**
   * Comps from ACTIVE listings. These are asking prices — treat them as a
   * weaker signal than a confirmed sale, which the pricing engine does.
   */
  async searchComps(query: CompQuery, creds: AdapterCredentials): Promise<Comp[]> {
    const token = this.requireToken(creds);
    const q = buildSearchQuery(query);
    if (!q) return [];

    const params = new URLSearchParams({
      q,
      limit: String(Math.min(query.limit ?? 25, 50)),
      filter: 'buyingOptions:{FIXED_PRICE},conditionIds:{3000|4000|5000|6000}',
    });

    const data = await this.request<EbayBrowseResponse>(
      `/buy/browse/v1/item_summary/search?${params.toString()}`,
      { method: 'GET', token },
    );

    const now = new Date().toISOString();
    return (data.itemSummaries ?? [])
      .map((item): Comp => {
        const priceCents = toCents(item.price?.value);
        return {
          source: 'ebay_active',
          platform: 'ebay',
          priceCents,
          similarity: scoreSimilarity(item.title ?? '', query),
          observedAt: now,
          title: item.title,
          url: item.itemWebUrl,
        };
      })
      .filter((c) => c.priceCents > 0 && c.similarity > 0.25);
  }

  // -------------------------------------------------------------------------

  private requireToken(creds: AdapterCredentials): string {
    if (!creds.accessToken) {
      throw new NotConnectedError('ebay', 'Your eBay account is not connected.', 'reconnect');
    }
    if (creds.expiresAt && new Date(creds.expiresAt).getTime() < Date.now()) {
      throw new NotConnectedError('ebay', 'Your eBay session expired.', 'reconnect');
    }
    return creds.accessToken;
  }

  private requirePolicies(creds: AdapterCredentials) {
    const meta = creds.meta ?? {};
    const missing = [
      'fulfillmentPolicyId',
      'paymentPolicyId',
      'returnPolicyId',
      'merchantLocationKey',
    ].filter((key) => !meta[key]);

    if (missing.length > 0) {
      throw new NotConnectedError(
        'ebay',
        `eBay needs your shipping, payment and return policies set up in Seller Hub before Tagged can list. Missing: ${missing.join(', ')}.`,
        'reconnect',
      );
    }

    return {
      fulfillmentPolicyId: meta['fulfillmentPolicyId']!,
      paymentPolicyId: meta['paymentPolicyId']!,
      returnPolicyId: meta['returnPolicyId']!,
      merchantLocationKey: meta['merchantLocationKey']!,
    };
  }

  private async findExistingOffer(sku: string, token: string): Promise<string | null> {
    try {
      const data = await this.request<{ offers?: Array<{ offerId?: string }> }>(
        `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`,
        { method: 'GET', token },
      );
      return data.offers?.[0]?.offerId ?? null;
    } catch {
      return null;
    }
  }

  private async request<T = unknown>(
    path: string,
    opts: {
      method: string;
      token: string;
      body?: unknown;
      idempotencyKey?: string;
    },
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${opts.token}`,
      'content-type': 'application/json',
      'content-language': 'en-US',
      accept: 'application/json',
    };
    if (opts.idempotencyKey) headers['x-ebay-c-idempotency-key'] = opts.idempotencyKey;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.hosts.api}${path}`, {
        method: opts.method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (cause) {
      throw new MarketplaceError(
        'ebay',
        `Could not reach eBay: ${cause instanceof Error ? cause.message : String(cause)}`,
        undefined,
        true,
      );
    }

    if (response.status === 204) return {} as T;

    const text = await response.text();
    const json = text ? safeJson(text) : {};

    if (!response.ok) {
      const errors = (json as { errors?: Array<{ message?: string; longMessage?: string }> }).errors;
      const message = errors?.map((e) => e.longMessage ?? e.message).filter(Boolean).join('; ')
        || `HTTP ${response.status}`;

      if (response.status === 401) {
        throw new NotConnectedError('ebay', 'eBay rejected the session. Reconnect the account.', 'reconnect');
      }
      throw new MarketplaceError(
        'ebay',
        message,
        response.status,
        response.status === 429 || response.status >= 500,
      );
    }

    return json as T;
  }
}

// ---------------------------------------------------------------------------

interface EbayBrowseResponse {
  itemSummaries?: Array<{
    title?: string;
    itemWebUrl?: string;
    price?: { value?: string };
  }>;
}

interface EbayOrdersResponse {
  orders?: Array<{
    orderId?: string;
    creationDate?: string;
    buyer?: { username?: string };
    lineItems?: Array<{
      lineItemId?: string;
      legacyItemId?: string;
      total?: { value?: string };
    }>;
  }>;
}

/** Rough token-overlap similarity. Good enough to filter obvious mismatches. */
function scoreSimilarity(title: string, query: CompQuery): number {
  const haystack = title.toLowerCase();
  let score = 0;
  let possible = 0;

  if (query.brand) {
    possible += 3;
    if (haystack.includes(query.brand.toLowerCase())) score += 3;
  }
  if (query.styleNumber) {
    possible += 3;
    if (haystack.includes(query.styleNumber.toLowerCase())) score += 3;
  }
  if (query.category) {
    possible += 2;
    if (haystack.includes(query.category.toLowerCase())) score += 2;
  }
  for (const keyword of query.keywords.slice(0, 5)) {
    possible += 1;
    if (haystack.includes(keyword.toLowerCase())) score += 1;
  }

  return possible === 0 ? 0.4 : Math.min(1, score / possible);
}

function toAspects(attributes: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value) out[key] = [value];
  }
  return out;
}

function mapCondition(condition: string | undefined): string {
  switch (condition) {
    case 'new_with_tags': return 'NEW_WITH_TAGS';
    case 'new_without_tags': return 'NEW_WITHOUT_TAGS';
    case 'excellent':
    case 'good': return 'USED_EXCELLENT';
    case 'fair': return 'USED_GOOD';
    case 'poor': return 'USED_ACCEPTABLE';
    default: return 'USED_EXCELLENT';
  }
}

function toHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<div>${escaped.split('\n\n').map((p) => `<p>${p.replace(/\n/g, '<br/>')}</p>`).join('')}</div>`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function base64(input: string): string {
  if (typeof btoa === 'function') return btoa(input);
  // Node without a global btoa.
  return Buffer.from(input, 'utf8').toString('base64');
}

/** Convenience for the app's listing→publish path. */
export function skuForItem(itemId: string): string {
  return `TAGGED-${itemId.replace(/-/g, '').slice(0, 24).toUpperCase()}`;
}

export type { PlatformListing };
