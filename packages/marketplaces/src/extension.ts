import type { PlatformId } from '@tagged/core';

import { NotConnectedError } from './adapter';
import type {
  AdapterCredentials,
  EndInput,
  MarketplaceAdapter,
  PublishInput,
  PublishResult,
  SoldItem,
} from './adapter';

/**
 * The extension bridge.
 *
 * Poshmark, Mercari, Depop and Grailed have no usable public API. The only
 * route — and the one every incumbent in this category uses — is a browser
 * extension that drives the seller's own logged-in session on their own
 * machine.
 *
 * Server-side that means these platforms are ASYNCHRONOUS. `publish` cannot
 * return a listing id, because nothing has happened yet: it enqueues a command
 * that the extension picks up next time the seller's browser is open. The
 * listing sits in `publishing` until the extension reports back.
 *
 * Safety posture, which is deliberate and should not be "optimized" away:
 *   • Commands only ever act on the seller's own account.
 *   • The extension holds no credentials — it borrows the session cookie the
 *     browser already has. Tagged never sees or stores a marketplace password.
 *   • Execution is human-paced with randomized delays and a daily cap.
 *   • Nothing runs unattended; the seller starts each batch.
 */

export type ExtensionCommandKind = 'publish' | 'end' | 'update_price' | 'fetch_sold' | 'share_closet' | 'offer_to_likers';

export interface ExtensionCommand {
  id: string;
  userId: string;
  platform: PlatformId;
  kind: ExtensionCommandKind;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
  createdAt: string;
}

/**
 * Persistence for the command queue. Implemented by the app against Postgres —
 * this package stays storage-agnostic so it can be unit tested without a
 * database and reused from an edge worker.
 */
export interface ExtensionQueue {
  enqueue(command: Omit<ExtensionCommand, 'id' | 'status' | 'attempts' | 'createdAt'>): Promise<string>;
  /** Most recent heartbeat from this user's extension, or null if never seen. */
  lastSeen(userId: string, platform: PlatformId): Promise<Date | null>;
  /** Sold items the extension has already reported and we have not consumed. */
  drainSold(userId: string, platform: PlatformId, since: Date): Promise<SoldItem[]>;
}

/** Returned by `publish` because the real id does not exist yet. */
export const PENDING_EXTERNAL_ID = '__pending__';

/** If the extension has not checked in for this long, treat it as offline. */
const HEARTBEAT_STALE_MINUTES = 15;

export class ExtensionAdapter implements MarketplaceAdapter {
  constructor(
    readonly platform: PlatformId,
    private readonly queue: ExtensionQueue,
    private readonly userId: string,
  ) {}

  async publish(input: PublishInput, creds: AdapterCredentials): Promise<PublishResult> {
    await this.assertReachable(creds);

    await this.queue.enqueue({
      userId: this.userId,
      platform: this.platform,
      kind: 'publish',
      idempotencyKey: input.idempotencyKey,
      payload: {
        itemId: input.itemId,
        sku: input.sku,
        title: input.listing.title,
        description: input.listing.description,
        priceCents: input.listing.priceCents,
        tags: input.listing.tags,
        attributes: input.listing.attributes,
        imageUrls: input.imageUrls,
      },
    });

    return {
      externalId: PENDING_EXTERNAL_ID,
      externalUrl: null,
      warnings: [
        ...input.listing.warnings,
        'Queued for your browser extension. It will publish next time your browser is open.',
      ],
    };
  }

  async end(input: EndInput, creds: AdapterCredentials): Promise<void> {
    // Deliberately does NOT assert reachability. A delist must be queued even
    // when the browser is closed — the whole point is that it happens as soon
    // as it can, rather than being dropped because the seller is asleep.
    void creds;
    await this.queue.enqueue({
      userId: this.userId,
      platform: this.platform,
      kind: 'end',
      idempotencyKey: input.idempotencyKey,
      payload: { externalId: input.externalId, reason: input.reason },
    });
  }

  async updatePrice(externalId: string, priceCents: number, creds: AdapterCredentials): Promise<void> {
    void creds;
    await this.queue.enqueue({
      userId: this.userId,
      platform: this.platform,
      kind: 'update_price',
      idempotencyKey: `price:${externalId}:${priceCents}`,
      payload: { externalId, priceCents },
    });
  }

  /**
   * Reads what the extension already reported rather than fetching live. The
   * extension polls the seller's own sold page while the browser is open and
   * pushes results up; this drains that buffer.
   */
  async fetchSold(since: Date, creds: AdapterCredentials): Promise<SoldItem[]> {
    void creds;
    return this.queue.drainSold(this.userId, this.platform, since);
  }

  private async assertReachable(creds: AdapterCredentials): Promise<void> {
    if (creds.meta?.['sessionPresent'] !== 'true') {
      throw new NotConnectedError(
        this.platform,
        `Sign in to ${this.platform} in the browser where the Tagged extension is installed.`,
        'open_browser',
      );
    }

    const seen = await this.queue.lastSeen(this.userId, this.platform);
    if (!seen) {
      throw new NotConnectedError(
        this.platform,
        'The Tagged browser extension has not been detected. Install it to reach this marketplace.',
        'install_extension',
      );
    }

    const staleMs = HEARTBEAT_STALE_MINUTES * 60_000;
    if (Date.now() - seen.getTime() > staleMs) {
      throw new NotConnectedError(
        this.platform,
        'Your browser extension has not checked in recently. Open the browser where it is installed.',
        'open_browser',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Poshmark-specific growth actions
// ---------------------------------------------------------------------------

/**
 * Sharing a closet drives more Poshmark visibility than any amount of listing
 * copy, and sending offers to likers converts better than a price drop. These
 * are the reasons a large share of Poshmark sellers pay for tooling at all.
 */
export class PoshmarkActions {
  constructor(
    private readonly queue: ExtensionQueue,
    private readonly userId: string,
  ) {}

  /** `dayKey` makes this idempotent per day — sharing twice is spam. */
  async shareCloset(dayKey: string): Promise<string> {
    return this.queue.enqueue({
      userId: this.userId,
      platform: 'poshmark',
      kind: 'share_closet',
      idempotencyKey: `share:${this.userId}:${dayKey}`,
      payload: {},
    });
  }

  async offerToLikers(externalId: string, discountPercent: number, shippingDiscount: boolean): Promise<string> {
    const pct = Math.max(10, Math.min(50, Math.round(discountPercent)));
    return this.queue.enqueue({
      userId: this.userId,
      platform: 'poshmark',
      kind: 'offer_to_likers',
      idempotencyKey: `offer:${externalId}:${pct}`,
      payload: { externalId, discountPercent: pct, shippingDiscount },
    });
  }
}

/**
 * Execution pacing, shared by every adapter inside the extension.
 *
 * Randomized so the traffic does not look like a script, capped so a runaway
 * loop cannot burn through a seller's account standing. These numbers are a
 * safety feature, not a performance knob.
 */
export const EXTENSION_PACING = {
  minDelayMs: 2_400,
  maxDelayMs: 6_800,
  maxActionsPerHour: 120,
  maxActionsPerDay: 800,
} as const;

export function nextDelayMs(random: () => number = Math.random): number {
  const { minDelayMs, maxDelayMs } = EXTENSION_PACING;
  return Math.round(minDelayMs + random() * (maxDelayMs - minDelayMs));
}
