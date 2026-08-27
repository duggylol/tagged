import { MarketplaceError, NotConnectedError, toCents } from './adapter';
import type {
  AdapterCredentials,
  EndInput,
  MarketplaceAdapter,
  PublishInput,
  PublishResult,
  SoldItem,
} from './adapter';

/**
 * Etsy Open API v3.
 *
 * Two things shape this adapter:
 *
 * 1. Etsy has no webhooks. Sale detection is polling `/receipts` on a
 *    schedule, which is why the cron worker exists.
 * 2. Secondhand clothing must be genuine vintage — 20 years or older. Listing
 *    modern used goods violates their policy and risks the seller's shop, so
 *    `publish` refuses rather than letting it through.
 */

const API_BASE = 'https://api.etsy.com/v3/application';
const CONNECT_URL = 'https://www.etsy.com/oauth/connect';
const TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';

export const ETSY_SCOPES = ['listings_r', 'listings_w', 'listings_d', 'transactions_r', 'shops_r'];

export interface EtsyConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

export interface EtsyTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export class EtsyAdapter implements MarketplaceAdapter {
  readonly platform = 'etsy' as const;

  private readonly config: Omit<EtsyConfig, 'fetchImpl'>;
  private readonly fetchImpl: typeof fetch;

  constructor(config: EtsyConfig) {
    this.config = config;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  // -------------------------------------------------------------------------
  // OAuth (PKCE — Etsy requires it)
  // -------------------------------------------------------------------------

  authorizeUrl(state: string, codeChallenge: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: ETSY_SCOPES.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${CONNECT_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<EtsyTokens> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      code,
      code_verifier: codeVerifier,
    });
  }

  async refresh(refreshToken: string): Promise<EtsyTokens> {
    return this.tokenRequest({
      grant_type: 'refresh_token',
      client_id: this.config.clientId,
      refresh_token: refreshToken,
    });
  }

  private async tokenRequest(body: Record<string, string>): Promise<EtsyTokens> {
    const response = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });

    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new MarketplaceError(
        'etsy',
        `Etsy token request failed: ${String(json['error_description'] ?? json['error'] ?? response.status)}`,
        response.status,
      );
    }

    const expiresIn = Number(json['expires_in'] ?? 3600);
    return {
      accessToken: String(json['access_token'] ?? ''),
      refreshToken: String(json['refresh_token'] ?? ''),
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Listing lifecycle
  // -------------------------------------------------------------------------

  async publish(input: PublishInput, creds: AdapterCredentials): Promise<PublishResult> {
    const token = this.requireToken(creds);
    const shopId = this.requireShopId(creds);
    const warnings = [...input.listing.warnings];

    // Policy guard. Etsy suspends shops over this, and a suspension costs the
    // seller far more than a missed listing.
    const era = input.listing.attributes['Vintage Era'] ?? input.listing.attributes['Decade'];
    if (!era) {
      throw new MarketplaceError(
        'etsy',
        'Etsy only allows vintage (20+ years old) secondhand clothing. No era was detected for this item, so Tagged will not publish it there. Set the era manually if it qualifies.',
      );
    }

    const created = await this.request<{ listing_id?: number }>(
      `/shops/${shopId}/listings`,
      {
        method: 'POST',
        token,
        form: {
          quantity: '1',
          title: input.listing.title,
          description: input.listing.description,
          price: (input.listing.priceCents / 100).toFixed(2),
          who_made: 'someone_else',
          when_made: mapWhenMade(era),
          taxonomy_id: creds.meta?.['taxonomyId'] ?? '266', // Women's Clothing
          listing_type: 'physical',
          state: 'draft',
          ...(input.listing.tags.length > 0
            ? { tags: input.listing.tags.slice(0, 13).map(sanitizeTag).filter(Boolean).join(',') }
            : {}),
        },
      },
    );

    const listingId = created.listing_id;
    if (!listingId) {
      throw new MarketplaceError('etsy', 'Etsy did not return a listing id.', undefined, true);
    }

    // Images must be attached before the listing can go active.
    let uploaded = 0;
    for (const url of input.imageUrls.slice(0, 10)) {
      try {
        await this.uploadImageFromUrl(shopId, listingId, url, token);
        uploaded += 1;
      } catch {
        warnings.push('One photo failed to upload to Etsy.');
      }
    }

    if (uploaded === 0) {
      throw new MarketplaceError(
        'etsy',
        'Etsy requires at least one photo and none uploaded successfully. The draft listing was created but not activated.',
        undefined,
        true,
      );
    }

    await this.request(`/shops/${shopId}/listings/${listingId}`, {
      method: 'PATCH',
      token,
      form: { state: 'active' },
    });

    return {
      externalId: String(listingId),
      externalUrl: `https://www.etsy.com/listing/${listingId}`,
      warnings,
    };
  }

  async end(input: EndInput, creds: AdapterCredentials): Promise<void> {
    const token = this.requireToken(creds);
    const shopId = this.requireShopId(creds);
    try {
      // Deactivate rather than delete — a deleted Etsy listing cannot be
      // restored, and a cancelled sale needs to be relistable.
      await this.request(`/shops/${shopId}/listings/${input.externalId}`, {
        method: 'PATCH',
        token,
        form: { state: 'inactive' },
      });
    } catch (error) {
      if (error instanceof MarketplaceError && error.status === 404) return;
      throw error;
    }
  }

  async updatePrice(externalId: string, priceCents: number, creds: AdapterCredentials): Promise<void> {
    const token = this.requireToken(creds);
    const shopId = this.requireShopId(creds);
    await this.request(`/shops/${shopId}/listings/${externalId}`, {
      method: 'PATCH',
      token,
      form: { price: (priceCents / 100).toFixed(2) },
    });
  }

  async fetchSold(since: Date, creds: AdapterCredentials): Promise<SoldItem[]> {
    const token = this.requireToken(creds);
    const shopId = this.requireShopId(creds);

    const params = new URLSearchParams({
      min_created: String(Math.floor(since.getTime() / 1000)),
      limit: '100',
      was_paid: 'true',
    });

    const data = await this.request<EtsyReceiptsResponse>(
      `/shops/${shopId}/receipts?${params.toString()}`,
      { method: 'GET', token },
    );

    const sold: SoldItem[] = [];
    for (const receipt of data.results ?? []) {
      for (const transaction of receipt.transactions ?? []) {
        if (!transaction.listing_id) continue;
        sold.push({
          externalId: String(transaction.listing_id),
          externalOrderId: String(receipt.receipt_id ?? ''),
          salePriceCents: transaction.price
            ? Math.round((transaction.price.amount / transaction.price.divisor) * 100)
            : toCents(transaction.price_str),
          feesCents: null,
          soldAt: receipt.created_timestamp
            ? new Date(receipt.created_timestamp * 1000).toISOString()
            : new Date().toISOString(),
          buyerHandle: receipt.name ?? null,
        });
      }
    }
    return sold;
  }

  // -------------------------------------------------------------------------

  private async uploadImageFromUrl(
    shopId: string,
    listingId: number,
    url: string,
    token: string,
  ): Promise<void> {
    const imageResponse = await this.fetchImpl(url);
    if (!imageResponse.ok) throw new Error(`Could not fetch image: ${url}`);
    const blob = await imageResponse.blob();

    const form = new FormData();
    form.append('image', blob, 'photo.webp');

    const response = await this.fetchImpl(
      `${API_BASE}/shops/${shopId}/listings/${listingId}/images`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'x-api-key': this.config.clientId,
        },
        body: form,
      },
    );

    if (!response.ok) {
      throw new MarketplaceError('etsy', `Image upload failed: HTTP ${response.status}`, response.status, true);
    }
  }

  private requireToken(creds: AdapterCredentials): string {
    if (!creds.accessToken) {
      throw new NotConnectedError('etsy', 'Your Etsy account is not connected.', 'reconnect');
    }
    if (creds.expiresAt && new Date(creds.expiresAt).getTime() < Date.now()) {
      throw new NotConnectedError('etsy', 'Your Etsy session expired.', 'reconnect');
    }
    return creds.accessToken;
  }

  private requireShopId(creds: AdapterCredentials): string {
    const shopId = creds.meta?.['shopId'];
    if (!shopId) {
      throw new NotConnectedError('etsy', 'No Etsy shop found on this account.', 'reconnect');
    }
    return shopId;
  }

  private async request<T = unknown>(
    path: string,
    opts: { method: string; token: string; form?: Record<string, string>; body?: unknown },
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${opts.token}`,
      'x-api-key': this.config.clientId,
      accept: 'application/json',
    };

    let body: string | undefined;
    if (opts.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(opts.form).toString();
    } else if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${API_BASE}${path}`, { method: opts.method, headers, body });
    } catch (cause) {
      throw new MarketplaceError(
        'etsy',
        `Could not reach Etsy: ${cause instanceof Error ? cause.message : String(cause)}`,
        undefined,
        true,
      );
    }

    const text = await response.text();
    const json = text ? safeJson(text) : {};

    if (!response.ok) {
      if (response.status === 401) {
        throw new NotConnectedError('etsy', 'Etsy rejected the session. Reconnect the account.', 'reconnect');
      }
      const message = (json as { error?: string }).error ?? `HTTP ${response.status}`;
      throw new MarketplaceError(
        'etsy',
        message,
        response.status,
        response.status === 429 || response.status >= 500,
      );
    }

    return json as T;
  }
}

// ---------------------------------------------------------------------------

interface EtsyReceiptsResponse {
  results?: Array<{
    receipt_id?: number;
    created_timestamp?: number;
    name?: string;
    transactions?: Array<{
      listing_id?: number;
      price?: { amount: number; divisor: number };
      price_str?: string;
    }>;
  }>;
}

/** Etsy's `when_made` is a controlled vocabulary, not a free-text year. */
function mapWhenMade(era: string): string {
  const year = Number.parseInt(era.replace(/\D/g, '').slice(0, 4), 10);
  if (!Number.isFinite(year)) return 'before_2004';
  if (year >= 2000) return '2000_2009';
  if (year >= 1990) return '1990s';
  if (year >= 1980) return '1980s';
  if (year >= 1970) return '1970s';
  if (year >= 1960) return '1960s';
  if (year >= 1950) return '1950s';
  return 'before_1940';
}

/** Etsy tags: max 20 chars, letters, numbers and spaces only. */
function sanitizeTag(tag: string): string {
  return tag.replace(/[^a-zA-Z0-9 ]/g, '').trim().slice(0, 20);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
