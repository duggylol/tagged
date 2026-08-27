import { getPlatform } from './platforms';
import { priceForPlatform } from './pricing';
import type {
  ExtractedAttributes,
  ListingCore,
  PlatformId,
  PlatformListing,
  PriceSuggestion,
} from './types';

/**
 * Platform adapters.
 *
 * One model call produces a neutral {@link ListingCore}. Everything here is
 * deterministic code that shapes it per marketplace. Doing it this way rather
 * than making five more model calls cuts cost roughly fivefold and — more
 * importantly — makes the output testable. A title truncation bug is a bug,
 * not a bad sample.
 */

export interface AdaptInput {
  core: ListingCore;
  attributes: ExtractedAttributes | null;
  price: PriceSuggestion;
  /** Override the computed price if the seller has set one. */
  priceCentsOverride?: number;
}

/** Build a title from ranked tokens, dropping the least important first. */
function packTitle(tokens: string[], maxChars: number): { title: string; dropped: number } {
  const kept: string[] = [];
  let length = 0;
  let dropped = 0;

  for (const raw of tokens) {
    const token = raw.trim();
    if (!token) continue;
    const cost = kept.length === 0 ? token.length : token.length + 1;
    if (length + cost <= maxChars) {
      kept.push(token);
      length += cost;
    } else {
      dropped += 1;
    }
  }

  if (kept.length === 0 && tokens.length > 0) {
    // Every token was too long on its own — hard-truncate the first.
    return { title: tokens[0]!.slice(0, maxChars).trim(), dropped: tokens.length - 1 };
  }
  return { title: kept.join(' '), dropped };
}

function clamp(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const cut = text.slice(0, maxChars - 1);
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '), cut.lastIndexOf(' '));
  const safe = lastBreak > maxChars * 0.6 ? cut.slice(0, lastBreak) : cut;
  return { text: safe.trimEnd(), truncated: true };
}

function toTags(keywords: string[], max: number, maxCharsEach: number): string[] {
  if (max === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const kw of keywords) {
    const tag = kw.trim().toLowerCase().slice(0, maxCharsEach);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

function buildDescription(
  core: ListingCore,
  opts: { tone: string; includeBullets: boolean; hashtags?: string[] },
): string {
  const sections: string[] = [];

  if (opts.tone === 'streetwear') {
    // Depop register: lowercase, short, hashtag-forward.
    sections.push(core.description.toLowerCase());
    if (core.disclosures.length > 0) {
      sections.push(core.disclosures.map((d) => d.toLowerCase()).join(' '));
    }
    if (opts.hashtags?.length) {
      sections.push(opts.hashtags.map((h) => `#${h.replace(/\s+/g, '')}`).join(' '));
    }
    return sections.join('\n\n');
  }

  sections.push(core.description);

  if (opts.includeBullets && core.bullets.length > 0) {
    sections.push(core.bullets.map((b) => `• ${b}`).join('\n'));
  }

  if (core.disclosures.length > 0) {
    sections.push(`Condition notes:\n${core.disclosures.map((d) => `• ${d}`).join('\n')}`);
  }

  return sections.join('\n\n');
}

/** Structured fields the marketplace indexes separately from free text. */
function buildAttributes(attrs: ExtractedAttributes | null, platform: PlatformId): Record<string, string> {
  if (!attrs) return {};
  const out: Record<string, string> = {};
  const set = (key: string, value: string | undefined) => {
    if (value && value.trim()) out[key] = value.trim();
  };

  set('Brand', attrs.brand);
  set('Size', attrs.size);
  set('Color', attrs.colors[0]);
  set('Material', attrs.material);
  set('Pattern', attrs.pattern);
  set('Department', attrs.department);
  set('Type', attrs.subcategory ?? attrs.category);
  set('Country/Region of Manufacture', attrs.countryOfOrigin);
  set('Style', attrs.line);

  if (platform === 'ebay') {
    set('MPN', attrs.styleNumber);
    if (attrs.colors.length > 1) set('Secondary Color', attrs.colors[1]);
    if (attrs.era) set('Decade', attrs.era);
  }

  if (platform === 'etsy' && attrs.era) {
    // Etsy secondhand clothing must be vintage; surface the era explicitly.
    set('Vintage Era', attrs.era);
  }

  return out;
}

export function adaptListing(platform: PlatformId, input: AdaptInput): PlatformListing {
  const spec = getPlatform(platform);
  const { core, attributes, price } = input;
  const warnings: string[] = [];

  const { title, dropped } = packTitle(
    core.titleTokens.length > 0 ? core.titleTokens : core.title.split(/\s+/),
    spec.title.maxChars,
  );
  if (dropped > 0) {
    warnings.push(
      `Title trimmed to ${spec.title.maxChars} characters — ${dropped} keyword${dropped === 1 ? '' : 's'} did not fit.`,
    );
  }

  const tags = toTags(core.keywords, spec.tags.max, spec.tags.maxCharsEach);
  if (spec.tags.max > 0 && tags.length < spec.tags.max) {
    warnings.push(`Only ${tags.length} of ${spec.tags.max} tag slots filled — unused slots are wasted reach.`);
  }

  const rawDescription = buildDescription(core, {
    tone: spec.tone,
    includeBullets: spec.description.maxChars > 800,
    hashtags: spec.tone === 'streetwear' ? core.keywords.slice(0, 5) : undefined,
  });
  const { text: description, truncated } = clamp(rawDescription, spec.description.maxChars);
  if (truncated) warnings.push('Description was shortened to fit this marketplace.');

  const priceCents = input.priceCentsOverride ?? priceForPlatform(price, platform);

  if (platform === 'etsy' && attributes && !attributes.era) {
    warnings.push(
      'Etsy only permits vintage (20+ years) secondhand clothing. No era was detected — confirm this item qualifies before publishing.',
    );
  }

  if (spec.tags.max === 0 && core.keywords.length > 0 && platform !== 'ebay') {
    warnings.push('This marketplace has no tag field — keywords were folded into the description instead.');
  }

  return {
    platform,
    title,
    description,
    tags,
    priceCents,
    attributes: buildAttributes(attributes, platform),
    warnings,
  };
}

/** Adapt once per connected platform. */
export function adaptForPlatforms(platforms: PlatformId[], input: AdaptInput): PlatformListing[] {
  return platforms.map((p) => adaptListing(p, input));
}

/**
 * Build the ranked title tokens from extracted attributes when the model's own
 * ordering is missing or unusable. Order matters: marketplaces weight the
 * front of the title, and buyers scan brand-first.
 */
export function defaultTitleTokens(attrs: ExtractedAttributes): string[] {
  const tokens: string[] = [];
  const push = (value: string | undefined) => {
    if (value && value.trim()) tokens.push(value.trim());
  };

  push(attrs.brand);
  push(attrs.line);
  push(attrs.colors[0]);
  push(attrs.pattern);
  push(attrs.subcategory ?? attrs.category);
  if (attrs.size) tokens.push(`Size ${attrs.size}`);
  push(attrs.era);
  push(attrs.material);
  for (const kw of attrs.styleKeywords.slice(0, 3)) tokens.push(kw);

  return tokens;
}
