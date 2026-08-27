import type { ItemStatus, Listing, ListingState, PlatformId } from './types';

/**
 * The inventory state machine.
 *
 * This is the part of Tagged people actually pay for, because the failure it
 * prevents — selling the same jacket twice and eating a cancellation strike —
 * is the thing every multi-platform seller fears.
 *
 * The ordering below is the whole design. Note that delisting happens BEFORE
 * the seller confirms anything: waiting for confirmation is precisely the
 * window in which a double-sale occurs. Ending a listing is reversible.
 * A cancellation strike is not.
 */

const TRANSITIONS: Record<ItemStatus, ItemStatus[]> = {
  draft: ['active', 'archived'],
  active: ['sale_detected', 'archived', 'draft'],
  sale_detected: ['delist_pending', 'active'],
  delist_pending: ['awaiting_confirm', 'sale_detected'],
  awaiting_confirm: ['sold', 'relisting'],
  relisting: ['active', 'archived'],
  sold: ['relisting'],
  archived: ['draft', 'active'],
};

export function canTransition(from: ItemStatus, to: ItemStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: ItemStatus,
    readonly to: ItemStatus,
  ) {
    super(`Cannot move an item from "${from}" to "${to}".`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: ItemStatus, to: ItemStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

// ---------------------------------------------------------------------------
// Delist orchestration
// ---------------------------------------------------------------------------

export interface DelistAction {
  listingId: string;
  platform: PlatformId;
  externalId: string;
  /**
   * Same key = same intended effect, applied once no matter how many times we
   * retry. Without this a network blip becomes a double-delist, or worse, a
   * relist of something already sold.
   */
  idempotencyKey: string;
}

export interface DelistPlan {
  /** The platform where the sale happened. Left alone. */
  soldOn: PlatformId;
  /** Everywhere else that is live and must come down. */
  actions: DelistAction[];
  /** Listings we cannot act on right now, with the reason why. */
  skipped: Array<{ platform: PlatformId; reason: string }>;
}

/**
 * Given a sale on one platform, work out exactly what to end everywhere else.
 *
 * `saleRef` should be a stable identifier for the sale (the marketplace order
 * id, or `${itemId}:${detectedAt}` when the platform gives us nothing better).
 * It is what makes the idempotency keys stable across retries.
 */
export function planDelist(
  listings: Listing[],
  soldOn: PlatformId,
  saleRef: string,
): DelistPlan {
  const actions: DelistAction[] = [];
  const skipped: Array<{ platform: PlatformId; reason: string }> = [];

  for (const listing of listings) {
    if (listing.platform === soldOn) continue;

    if (listing.state === 'active') {
      if (!listing.externalId) {
        skipped.push({
          platform: listing.platform,
          reason: 'Listing is marked active but has no marketplace id — needs manual review.',
        });
        continue;
      }
      actions.push({
        listingId: listing.id,
        platform: listing.platform,
        externalId: listing.externalId,
        idempotencyKey: `delist:${saleRef}:${listing.platform}:${listing.externalId}`,
      });
    } else if (listing.state === 'publishing') {
      // Racing a publish. Queue it anyway — the worker retries until the
      // external id exists, then ends it.
      skipped.push({
        platform: listing.platform,
        reason: 'Publish still in flight. Will be ended as soon as it completes.',
      });
    } else if (listing.state === 'error') {
      skipped.push({
        platform: listing.platform,
        reason: 'Listing is in an error state. Check it by hand before assuming it is down.',
      });
    }
    // not_listed / ending / ended / sold need no action.
  }

  return { soldOn, actions, skipped };
}

/** True once every non-selling platform has stopped being live. */
export function isFullyDelisted(listings: Listing[], soldOn: PlatformId): boolean {
  return listings
    .filter((l) => l.platform !== soldOn)
    .every((l) => l.state === 'ended' || l.state === 'not_listed' || l.state === 'sold');
}

// ---------------------------------------------------------------------------
// Relist
// ---------------------------------------------------------------------------

export interface RelistAction {
  listingId: string;
  platform: PlatformId;
  idempotencyKey: string;
}

/**
 * A cancelled or returned sale should cost the seller one tap, not a
 * re-entry chore. Every ended listing kept a full payload snapshot precisely
 * so this can replay it.
 */
export function planRelist(listings: Listing[], relistRef: string): {
  actions: RelistAction[];
  skipped: Array<{ platform: PlatformId; reason: string }>;
} {
  const actions: RelistAction[] = [];
  const skipped: Array<{ platform: PlatformId; reason: string }> = [];

  for (const listing of listings) {
    if (listing.state !== 'ended' && listing.state !== 'sold') continue;

    if (!listing.payloadSnapshot) {
      skipped.push({
        platform: listing.platform,
        reason: 'No saved listing content to restore from. Rebuild this one from the item.',
      });
      continue;
    }
    actions.push({
      listingId: listing.id,
      platform: listing.platform,
      idempotencyKey: `relist:${relistRef}:${listing.platform}`,
    });
  }

  return { actions, skipped };
}

// ---------------------------------------------------------------------------
// Derived item status
// ---------------------------------------------------------------------------

/**
 * What the item's status ought to be, given its listings. Used by the
 * reconciliation job to catch drift between what we think happened and what
 * the marketplaces actually did.
 */
export function deriveStatus(current: ItemStatus, listings: Listing[]): ItemStatus {
  // Terminal and human-gated states are never auto-corrected. In particular
  // `awaiting_confirm` must survive until the seller taps confirm — that is
  // the entire point of the confirmation step.
  if (current === 'sold' || current === 'archived' || current === 'awaiting_confirm') {
    return current;
  }

  const anySold = listings.some((l) => l.state === 'sold');
  if (anySold) {
    const soldOn = listings.find((l) => l.state === 'sold')!.platform;
    return isFullyDelisted(listings, soldOn) ? 'awaiting_confirm' : 'delist_pending';
  }

  const anyActive = listings.some((l) => l.state === 'active' || l.state === 'publishing');
  if (anyActive) return 'active';

  return current === 'relisting' ? 'relisting' : 'draft';
}

/** Human-facing label. Kept here so web and native render the same words. */
export function describeStatus(status: ItemStatus): { label: string; hint: string } {
  switch (status) {
    case 'draft':
      return { label: 'Draft', hint: 'Not listed anywhere yet.' };
    case 'active':
      return { label: 'Listed', hint: 'Live and for sale.' };
    case 'sale_detected':
      return { label: 'Sold — syncing', hint: 'Taking it down from your other marketplaces.' };
    case 'delist_pending':
      return { label: 'Removing listings', hint: 'Ending listings on the other platforms.' };
    case 'awaiting_confirm':
      return { label: 'Confirm sale', hint: 'Removed everywhere. Confirm once the buyer has paid.' };
    case 'sold':
      return { label: 'Sold', hint: 'Confirmed and booked.' };
    case 'relisting':
      return { label: 'Relisting', hint: 'Putting it back up from your saved listing.' };
    case 'archived':
      return { label: 'Archived', hint: 'Withdrawn from sale.' };
  }
}

export function listingStateLabel(state: ListingState): string {
  switch (state) {
    case 'not_listed': return 'Not listed';
    case 'publishing': return 'Publishing…';
    case 'active': return 'Live';
    case 'ending': return 'Ending…';
    case 'ended': return 'Ended';
    case 'sold': return 'Sold here';
    case 'error': return 'Failed';
  }
}
