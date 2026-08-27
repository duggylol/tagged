/**
 * JSON schemas shared by every provider.
 *
 * Written to the intersection of what Gemini's `responseSchema` and
 * Anthropic's tool `input_schema` both accept: no `$ref`, no `oneOf`, no
 * `additionalProperties`. Keeping one schema for both providers is what makes
 * them genuinely swappable.
 */

export const ATTRIBUTES_SCHEMA = {
  type: 'object',
  properties: {
    brand: {
      type: 'string',
      description:
        'Brand exactly as printed on the label. Leave empty if you cannot read it — do not guess from styling.',
    },
    line: {
      type: 'string',
      description: 'Sub-line, collection or collaboration, e.g. "ACG", "Silver Tab". Empty if none.',
    },
    size: { type: 'string', description: 'Size as printed: "M", "32x34", "8", "One Size".' },
    sizeNormalized: {
      type: 'string',
      description: 'Lowercase normalized size for filtering: xs, s, m, l, xl, xxl, or a number.',
    },
    category: {
      type: 'string',
      description: 'Broad category, e.g. "Outerwear", "Tops", "Bottoms", "Footwear", "Accessories".',
    },
    subcategory: {
      type: 'string',
      description: 'Specific type, e.g. "Bomber Jacket", "Crewneck Sweatshirt", "Straight Leg Jeans".',
    },
    department: {
      type: 'string',
      enum: ['mens', 'womens', 'unisex', 'kids', 'unknown'],
    },
    colors: {
      type: 'array',
      items: { type: 'string' },
      description: 'Plain colour names, most dominant first. One to three entries.',
    },
    pattern: { type: 'string', description: 'e.g. "Solid", "Plaid", "Floral", "Striped". Empty if unclear.' },
    material: { type: 'string', description: 'Fabric content from the care tag, e.g. "100% Cotton".' },
    styleKeywords: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Three to eight search keywords a buyer would actually type: aesthetic, era, silhouette, use case.',
    },
    era: { type: 'string', description: 'Decade if the label design or construction clearly indicates one, e.g. "1990s".' },
    styleNumber: {
      type: 'string',
      description: 'Style or SKU number printed on the care tag. This is the single most valuable field — transcribe it exactly.',
    },
    rnNumber: { type: 'string', description: 'FTC RN number if printed, digits only.' },
    countryOfOrigin: { type: 'string', description: 'From the care tag, e.g. "Made in Portugal" -> "Portugal".' },
    condition: {
      type: 'string',
      enum: ['new_with_tags', 'new_without_tags', 'excellent', 'good', 'fair', 'poor'],
    },
    defects: {
      type: 'array',
      description: 'Every visible flaw. Under-reporting flaws costs the seller a return and a rating hit.',
      items: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['stain', 'hole', 'tear', 'pilling', 'fading', 'missing_part', 'odor', 'other'],
          },
          location: { type: 'string', description: 'Where on the garment, in plain language.' },
          severity: { type: 'string', enum: ['minor', 'moderate', 'significant'] },
          disclosure: {
            type: 'string',
            description: 'One neutral sentence a seller can paste into the listing.',
          },
        },
        required: ['kind', 'location', 'severity', 'disclosure'],
      },
    },
    measurements: {
      type: 'array',
      description:
        'Only include when a reference object of known size is visibly in frame. An invented measurement causes returns.',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'pit_to_pit, length, sleeve, waist, inseam, rise' },
          inches: { type: 'number' },
          source: { type: 'string', enum: ['estimated', 'reference_object', 'manual'] },
        },
        required: ['key', 'inches', 'source'],
      },
    },
    confidence: {
      type: 'number',
      description:
        'Zero to one. How confident you are in brand and category together. Be honest — a low number sends this to human review, which is the correct outcome when the tag is unreadable.',
    },
    uncertainNotes: {
      type: 'array',
      items: { type: 'string' },
      description: 'Short notes on anything you could not determine and why. Shown to the seller.',
    },
  },
  required: ['colors', 'styleKeywords', 'defects', 'measurements', 'confidence', 'uncertainNotes'],
} as const;

export const LISTING_CORE_SCHEMA = {
  type: 'object',
  properties: {
    titleTokens: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Title fragments ranked most to least important. Adapters drop from the end to fit each marketplace, so the first token must be the one a buyer searches — usually the brand.',
    },
    title: { type: 'string', description: 'A single fallback title under 80 characters.' },
    bullets: {
      type: 'array',
      items: { type: 'string' },
      description: 'Three to five short selling points. No marketing adjectives without a fact behind them.',
    },
    description: {
      type: 'string',
      description:
        'Body copy, plain text with paragraph breaks. Factual and specific. No HTML, no emoji, no invented history.',
    },
    keywords: {
      type: 'array',
      items: { type: 'string' },
      description: 'Up to 13 lowercase search keywords ranked by value. No repeats of each other.',
    },
    disclosures: {
      type: 'array',
      items: { type: 'string' },
      description: 'One sentence per flaw, neutral and specific. Empty array if the item is flawless.',
    },
  },
  required: ['titleTokens', 'title', 'bullets', 'description', 'keywords', 'disclosures'],
} as const;
