import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeDashboardMetrics } from './analytics';
import { groupPhotos, phashDistance, selectPhotosForAnalysis } from './capture';
import { calculateNetProceeds, compareAcrossPlatforms, maxSourcingPrice } from './fees';
import { adaptListing } from './listing-adapters';
import { suggestPrice, suggestPriceDrop } from './pricing';
import { canTransition, deriveStatus, isFullyDelisted, planDelist, planRelist } from './state-machine';
import type { CapturePhoto, Comp, Item, Listing, ListingCore, Sale } from './types';

/**
 * Tests for the logic that has to be right.
 *
 * The bias here is toward the paths where being wrong costs a seller real
 * money: fee arithmetic, delist planning, and the guarantee that a flaw the
 * model found always ends up disclosed.
 *
 * Run with:  npm test
 */

// ---------------------------------------------------------------------------
// Fees
// ---------------------------------------------------------------------------

test('Poshmark charges a flat fee below its threshold, not a percentage', () => {
  const cheap = calculateNetProceeds({ platform: 'poshmark', salePriceCents: 1000 });
  assert.equal(cheap.marketplaceFeeCents, 295, 'under $15 should be the flat $2.95');

  const dear = calculateNetProceeds({ platform: 'poshmark', salePriceCents: 10000 });
  assert.equal(dear.marketplaceFeeCents, 2000, 'over $15 should be 20%');
});

test('net proceeds subtract cost basis and shipping', () => {
  const proceeds = calculateNetProceeds({
    platform: 'ebay',
    salePriceCents: 5000,
    shippingCostCents: 800,
    costBasisCents: 400,
  });

  // 5000 - 662 (13.25%) - 40 fixed - 800 shipping = 3498 net revenue
  assert.equal(proceeds.marketplaceFeeCents, 663);
  assert.equal(proceeds.netRevenueCents, 5000 - 663 - 40 - 800);
  assert.equal(proceeds.profitCents, proceeds.netRevenueCents - 400);
});

test('the cross-platform comparison is ranked by what the seller keeps', () => {
  const rows = compareAcrossPlatforms(['ebay', 'poshmark', 'depop'], 4000, { costBasisCents: 500 });
  assert.equal(rows.length, 3);

  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(
      rows[i - 1]!.profitCents >= rows[i]!.profitCents,
      'rows must be sorted by profit, descending',
    );
  }
});

test('the sourcing ceiling leaves room for the target margin', () => {
  const max = maxSourcingPrice('ebay', 5000, 0.4);
  const proceeds = calculateNetProceeds({
    platform: 'ebay',
    salePriceCents: 5000,
    costBasisCents: max,
  });
  assert.ok(proceeds.profitCents >= 5000 * 0.4 - 1, 'paying the ceiling should still hit the margin');
});

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

function comp(priceCents: number, overrides: Partial<Comp> = {}): Comp {
  return {
    source: 'internal_sold',
    priceCents,
    similarity: 0.9,
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

test('an empty comp set returns zero confidence rather than a confident guess', () => {
  const result = suggestPrice([]);
  assert.equal(result.confidence, 0);
  assert.equal(result.sampleSize, 0);
  assert.match(result.rationale, /No comparable/);
});

test('confirmed sales outweigh active asking prices', () => {
  const soldLow = [comp(2000), comp(2100), comp(1900), comp(2050), comp(2000)];
  const askingHigh = Array.from({ length: 5 }, () =>
    comp(8000, { source: 'ebay_active', platform: 'ebay' }),
  );

  const result = suggestPrice([...soldLow, ...askingHigh]);
  assert.ok(
    result.medianCents < 4000,
    `asking prices should not drag the median up to ${result.medianCents}`,
  );
});

test('a tight, well-sampled comp set is more confident than a scattered one', () => {
  const tight = suggestPrice(Array.from({ length: 8 }, () => comp(3000)));
  const scattered = suggestPrice([comp(500), comp(9000), comp(1200), comp(7500)]);
  assert.ok(tight.confidence > scattered.confidence);
});

test('price drops escalate with age and never breach the floor', () => {
  assert.equal(suggestPriceDrop(5000, 10, 3000), null, 'nothing under 30 days');

  const at30 = suggestPriceDrop(5000, 35, 3000);
  const at90 = suggestPriceDrop(5000, 95, 3000);
  assert.ok(at30 && at90);
  assert.ok(at90.dropPercent > at30.dropPercent, '90-day items need a bigger cut');

  const nearFloor = suggestPriceDrop(3200, 95, 3000);
  assert.ok(nearFloor === null || nearFloor.newPriceCents >= 3000, 'never below the floor');
});

// ---------------------------------------------------------------------------
// Listing adapters
// ---------------------------------------------------------------------------

const CORE: ListingCore = {
  titleTokens: ['Patagonia', 'Synchilla', 'Fleece', 'Pullover', 'Deep Pile', 'Size Medium', '1990s'],
  title: 'Patagonia Synchilla Fleece Pullover',
  bullets: ['Deep pile fleece', 'Made in USA'],
  description: 'A heavyweight Synchilla pullover.',
  keywords: ['patagonia', 'synchilla', 'fleece', 'gorpcore', 'vintage', 'outdoor', 'y2k'],
  disclosures: [],
};

const PRICE = {
  listPriceCents: 6500,
  floorPriceCents: 4500,
  medianCents: 6000,
  p25Cents: 5000,
  p75Cents: 7000,
  sampleSize: 9,
  confidence: 0.8,
  rationale: 'test',
};

test('titles are packed to each marketplace limit, dropping the least important first', () => {
  const ebay = adaptListing('ebay', { core: CORE, attributes: null, price: PRICE });
  const poshmark = adaptListing('poshmark', { core: CORE, attributes: null, price: PRICE });

  assert.ok(ebay.title.length <= 80);
  assert.ok(poshmark.title.length <= 50);
  assert.ok(poshmark.title.startsWith('Patagonia'), 'the brand must survive the trim');
  assert.ok(ebay.title.length > poshmark.title.length);
});

test('Etsy gets its 13 tag slots; eBay gets none', () => {
  const etsy = adaptListing('etsy', { core: CORE, attributes: null, price: PRICE });
  const ebay = adaptListing('ebay', { core: CORE, attributes: null, price: PRICE });

  assert.ok(etsy.tags.length > 0 && etsy.tags.length <= 13);
  assert.equal(ebay.tags.length, 0);
});

test('platform price multipliers are applied to the sticker', () => {
  const ebay = adaptListing('ebay', { core: CORE, attributes: null, price: PRICE });
  const poshmark = adaptListing('poshmark', { core: CORE, attributes: null, price: PRICE });

  assert.ok(
    poshmark.priceCents > ebay.priceCents,
    'Poshmark buyers expect to negotiate down, so the sticker runs higher',
  );
});

test('an item with no detected era warns before it can reach Etsy', () => {
  const listing = adaptListing('etsy', {
    core: CORE,
    attributes: {
      colors: [],
      styleKeywords: [],
      defects: [],
      measurements: [],
      confidence: 0.9,
      uncertainNotes: [],
    },
    price: PRICE,
  });

  assert.ok(listing.warnings.some((w) => /vintage/i.test(w)));
});

// ---------------------------------------------------------------------------
// State machine — the part that prevents double-sales
// ---------------------------------------------------------------------------

function listing(platform: Listing['platform'], state: Listing['state'], id = 'ext-1'): Listing {
  return {
    id: `listing-${platform}`,
    itemId: 'item-1',
    userId: 'user-1',
    platform,
    state,
    externalId: state === 'not_listed' ? null : id,
    externalUrl: null,
    priceCents: 5000,
    payloadSnapshot: state === 'ended' ? ({} as never) : null,
    lastError: null,
    publishedAt: null,
    endedAt: null,
  };
}

test('a sale on one platform plans a delist on every other live one', () => {
  const plan = planDelist(
    [
      listing('ebay', 'sold'),
      listing('poshmark', 'active'),
      listing('mercari', 'active'),
      listing('etsy', 'not_listed'),
    ],
    'ebay',
    'order-99',
  );

  assert.equal(plan.actions.length, 2);
  assert.deepEqual(
    plan.actions.map((a) => a.platform).sort(),
    ['mercari', 'poshmark'],
  );
  assert.ok(
    plan.actions.every((a) => a.idempotencyKey.includes('order-99')),
    'keys must be stable across retries',
  );
});

test('delist keys are identical for the same sale, so a retry cannot double-act', () => {
  const listings = [listing('ebay', 'sold'), listing('poshmark', 'active')];
  const first = planDelist(listings, 'ebay', 'order-99');
  const second = planDelist(listings, 'ebay', 'order-99');
  assert.equal(first.actions[0]!.idempotencyKey, second.actions[0]!.idempotencyKey);
});

test('a listing marked active with no marketplace id is skipped, not silently dropped', () => {
  const orphan = { ...listing('poshmark', 'active'), externalId: null };
  const plan = planDelist([listing('ebay', 'sold'), orphan], 'ebay', 'order-1');

  assert.equal(plan.actions.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0]!.reason, /manual review/);
});

test('awaiting_confirm survives reconciliation — only a human clears it', () => {
  const listings = [listing('ebay', 'sold'), listing('poshmark', 'ended')];
  assert.equal(deriveStatus('awaiting_confirm', listings), 'awaiting_confirm');
});

test('an item is only fully delisted once nothing else is live', () => {
  assert.equal(isFullyDelisted([listing('ebay', 'sold'), listing('poshmark', 'ending')], 'ebay'), false);
  assert.equal(isFullyDelisted([listing('ebay', 'sold'), listing('poshmark', 'ended')], 'ebay'), true);
});

test('relist only covers listings that kept a payload snapshot', () => {
  const withSnapshot = listing('poshmark', 'ended');
  const withoutSnapshot = { ...listing('mercari', 'ended'), payloadSnapshot: null };

  const plan = planRelist([withSnapshot, withoutSnapshot], 'relist-1');
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.skipped.length, 1);
});

test('invalid transitions are rejected', () => {
  assert.equal(canTransition('draft', 'sold'), false);
  assert.equal(canTransition('awaiting_confirm', 'sold'), true);
  assert.equal(canTransition('sold', 'relisting'), true);
});

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

function photo(overrides: Partial<CapturePhoto> = {}): CapturePhoto {
  return {
    id: crypto.randomUUID(),
    sessionId: 'session-1',
    userId: 'user-1',
    itemId: null,
    storagePath: 'path.webp',
    phash: null,
    width: 1200,
    height: 1600,
    sequence: 0,
    role: 'unspecified',
    createdAt: new Date('2026-01-01T10:00:00Z').toISOString(),
    ...overrides,
  };
}

test('an explicit item boundary always beats the time-gap heuristic', () => {
  const groups = groupPhotos([
    photo({ sequence: 1, itemId: 'item-a' }),
    photo({ sequence: 2, itemId: 'item-a' }),
    photo({ sequence: 3, itemId: 'item-b' }),
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0]!.photos.length, 2);
});

test('a long pause splits unassigned photos into separate items', () => {
  const groups = groupPhotos([
    photo({ sequence: 1, createdAt: '2026-01-01T10:00:00Z' }),
    photo({ sequence: 2, createdAt: '2026-01-01T10:00:20Z' }),
    photo({ sequence: 3, createdAt: '2026-01-01T10:05:00Z' }),
  ]);

  assert.equal(groups.length, 2);
});

test('the care tag is always sent to the model first', () => {
  const chosen = selectPhotosForAnalysis(
    [
      photo({ role: 'detail', sequence: 1 }),
      photo({ role: 'back', sequence: 2 }),
      photo({ role: 'tag', sequence: 3 }),
      photo({ role: 'front', sequence: 4 }),
      photo({ role: 'defect', sequence: 5 }),
      photo({ role: 'detail', sequence: 6 }),
    ],
    4,
  );

  assert.equal(chosen.length, 4);
  assert.equal(chosen[0]!.role, 'tag', 'the highest-signal frame goes first');
});

test('perceptual hash distance is zero for identical hashes', () => {
  assert.equal(phashDistance('ff00ff00', 'ff00ff00'), 0);
  assert.ok(phashDistance('ff00ff00', 'ff00ff01') > 0);
  assert.equal(phashDistance('abc', 'abcd'), Number.MAX_SAFE_INTEGER, 'different lengths never match');
});

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

test('metrics report net profit and ignore unconfirmed sales', () => {
  const items: Item[] = [
    {
      id: 'i1', userId: 'u', status: 'sold', analysisStatus: 'complete', title: 'A',
      attributes: null, listingCore: null, priceSuggestion: null, costBasisCents: 500,
      sourceNote: null, photoPaths: [], phash: null,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      listedAt: '2026-01-01T00:00:00Z', soldAt: '2026-01-11T00:00:00Z',
    },
    {
      id: 'i2', userId: 'u', status: 'active', analysisStatus: 'complete', title: 'B',
      attributes: null, listingCore: null, priceSuggestion: null, costBasisCents: 800,
      sourceNote: null, photoPaths: [], phash: null,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      listedAt: '2026-01-01T00:00:00Z', soldAt: null,
    },
  ];

  const sales: Sale[] = [
    {
      id: 's1', itemId: 'i1', userId: 'u', platform: 'ebay',
      salePriceCents: 5000, feesCents: 700, shippingCents: 0,
      costBasisCents: 500, profitCents: 3800,
      detectedAt: '2026-01-11T00:00:00Z', confirmedAt: '2026-01-11T00:00:00Z',
      detectionSource: 'webhook',
    },
    {
      id: 's2', itemId: 'i2', userId: 'u', platform: 'poshmark',
      salePriceCents: 9900, feesCents: 1980, shippingCents: 0,
      costBasisCents: 800, profitCents: 7120,
      detectedAt: '2026-01-12T00:00:00Z', confirmedAt: null, // NOT confirmed
      detectionSource: 'extension',
    },
  ];

  const metrics = computeDashboardMetrics(items, sales);

  assert.equal(metrics.salesCount, 1, 'unconfirmed sales must not be counted');
  assert.equal(metrics.netProfitCents, 3800);
  assert.equal(metrics.cashTiedUpCents, 800, 'only unsold inventory ties up cash');
  assert.equal(metrics.sellThroughRate, 0.5);
  assert.equal(metrics.medianDaysToSale, 10);
});
