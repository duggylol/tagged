import type { Defect, ExtractedAttributes, ItemCondition, ListingCore, Measurement } from '@tagged/core';
import { defaultTitleTokens } from '@tagged/core';

/**
 * Coerce raw model JSON into domain objects.
 *
 * Schema-constrained output is very reliable but not a guarantee, and the one
 * time a provider returns `colors: "black"` instead of `["black"]` should be a
 * slightly-worse listing, not a 500. Everything here fails soft.
 */

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function strArray(value: unknown, max = 20): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const s = str(entry);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function clamp01(value: unknown, fallback = 0): number {
  const n = num(value);
  if (n === undefined) return fallback;
  return Math.max(0, Math.min(1, n));
}

const CONDITIONS: ItemCondition[] = [
  'new_with_tags',
  'new_without_tags',
  'excellent',
  'good',
  'fair',
  'poor',
];

const DEFECT_KINDS: Defect['kind'][] = [
  'stain',
  'hole',
  'tear',
  'pilling',
  'fading',
  'missing_part',
  'odor',
  'other',
];

const SEVERITIES: Defect['severity'][] = ['minor', 'moderate', 'significant'];

function normalizeDefects(value: unknown): Defect[] {
  if (!Array.isArray(value)) return [];
  const out: Defect[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const kindRaw = str(r['kind'])?.toLowerCase() as Defect['kind'] | undefined;
    const sevRaw = str(r['severity'])?.toLowerCase() as Defect['severity'] | undefined;
    const location = str(r['location']) ?? 'unspecified';
    const disclosure = str(r['disclosure']);
    if (!disclosure) continue; // a flaw with no sentence is not usable

    out.push({
      kind: kindRaw && DEFECT_KINDS.includes(kindRaw) ? kindRaw : 'other',
      location,
      severity: sevRaw && SEVERITIES.includes(sevRaw) ? sevRaw : 'minor',
      disclosure,
    });
  }
  return out;
}

function normalizeMeasurements(value: unknown): Measurement[] {
  if (!Array.isArray(value)) return [];
  const out: Measurement[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const key = str(r['key']);
    const inches = num(r['inches']);
    if (!key || inches === undefined || inches <= 0 || inches > 120) continue;

    const source = str(r['source']);
    out.push({
      key: key.toLowerCase().replace(/\s+/g, '_'),
      inches: Math.round(inches * 4) / 4, // quarter-inch precision is the honest resolution
      source:
        source === 'reference_object' || source === 'manual' ? source : 'estimated',
    });
  }
  return out;
}

export function normalizeAttributes(raw: unknown): ExtractedAttributes {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  const conditionRaw = str(r['condition'])?.toLowerCase().replace(/\s+/g, '_') as
    | ItemCondition
    | undefined;

  const attributes: ExtractedAttributes = {
    brand: str(r['brand']),
    line: str(r['line']),
    size: str(r['size']),
    sizeNormalized: str(r['sizeNormalized'])?.toLowerCase(),
    category: str(r['category']),
    subcategory: str(r['subcategory']),
    department: str(r['department']),
    colors: strArray(r['colors'], 3),
    pattern: str(r['pattern']),
    material: str(r['material']),
    styleKeywords: strArray(r['styleKeywords'], 8),
    era: str(r['era']),
    styleNumber: str(r['styleNumber']),
    rnNumber: str(r['rnNumber'])?.replace(/\D/g, '') || undefined,
    countryOfOrigin: str(r['countryOfOrigin']),
    condition: conditionRaw && CONDITIONS.includes(conditionRaw) ? conditionRaw : undefined,
    defects: normalizeDefects(r['defects']),
    measurements: normalizeMeasurements(r['measurements']),
    confidence: clamp01(r['confidence'], 0.3),
    uncertainNotes: strArray(r['uncertainNotes'], 6),
  };

  // Enforce the rule the prompt states: no readable brand means low confidence,
  // whatever the model reported. This is the guard that keeps unreviewed
  // mis-identified listings from reaching a marketplace.
  if (!attributes.brand && attributes.confidence > 0.5) {
    attributes.confidence = 0.45;
    attributes.uncertainNotes = [
      ...attributes.uncertainNotes,
      'Brand could not be read from the photos — confirm it before publishing.',
    ];
  }

  return attributes;
}

export function normalizeListingCore(raw: unknown, attributes: ExtractedAttributes): ListingCore {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  let titleTokens = strArray(r['titleTokens'], 14);
  if (titleTokens.length === 0) {
    const fallbackTitle = str(r['title']);
    titleTokens = fallbackTitle ? fallbackTitle.split(/\s+/) : defaultTitleTokens(attributes);
  }

  const description = str(r['description']) ?? '';
  const disclosures = strArray(r['disclosures'], 10);

  // Every recorded flaw must be disclosed. If the model dropped one, put it
  // back — this is a correctness guarantee, not a stylistic preference.
  const merged = [...disclosures];
  for (const defect of attributes.defects) {
    const already = merged.some((d) => d.toLowerCase().includes(defect.location.toLowerCase()));
    if (!already) merged.push(defect.disclosure);
  }

  return {
    titleTokens,
    title: str(r['title']) ?? titleTokens.join(' ').slice(0, 80),
    bullets: strArray(r['bullets'], 6),
    description,
    keywords: strArray(r['keywords'], 13).map((k) => k.toLowerCase()),
    disclosures: merged,
  };
}

/**
 * Providers occasionally wrap JSON in a markdown fence despite being told not
 * to. Cheaper to strip it than to retry.
 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(body);
  } catch {
    // Last resort: grab the outermost balanced object.
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw new Error('Model returned content that is not valid JSON.');
  }
}
