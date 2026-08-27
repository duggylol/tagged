import type { ExtractedAttributes, PlatformId } from '@tagged/core';
import { getPlatform } from '@tagged/core';

/**
 * Prompts.
 *
 * The recurring theme in both is permission to be uncertain. A model that
 * guesses "Nike" from a swoosh-adjacent logo produces a listing that gets the
 * seller a counterfeit strike; a model that returns an empty brand and a low
 * confidence score sends the item to human review, which is the correct and
 * cheap outcome.
 */

export const EXTRACTION_SYSTEM = `You are an expert secondhand clothing appraiser reading photographs of a single garment or accessory that a reseller is about to list.

Your job is to transcribe what is actually visible into structured data. You are not writing marketing copy and you are not making the item sound good.

Rules that matter more than completeness:

1. TRANSCRIBE, DO NOT INFER. If the care tag is blurred, folded, or absent, leave the field empty. A wrong brand costs the seller a return, a refund, and possibly a counterfeit strike that ends their account. An empty field costs them ten seconds of typing.

2. THE CARE TAG IS THE MOST IMPORTANT IMAGE. Read every line of it. The style or SKU number is the single highest-value thing you can return — it turns a guess into an exact product lookup. Transcribe it character for character, including letters and dashes. Do the same for an RN number.

3. REPORT EVERY FLAW YOU CAN SEE. Stains, holes, pilling, fading, stretched cuffs, missing buttons, altered hems. Sellers who under-disclose get returns and rating damage. For each flaw write one neutral factual sentence they can paste directly into a listing — "Small faint stain on the left cuff, roughly 1cm" not "minor imperfection adds character".

4. ONLY MEASURE WHEN YOU CAN. Return measurements exclusively when an object of known size is clearly in frame — a credit card, a ruler, a printed measuring mat. Never estimate from the garment alone. An invented measurement causes a guaranteed return.

5. SET CONFIDENCE HONESTLY. This score decides whether a human reviews the listing before it goes live. Score your confidence in brand and category together. If you cannot read the brand, confidence must be below 0.5 no matter how sure you are about everything else.

6. NOTE WHAT YOU COULD NOT DETERMINE in uncertainNotes, briefly, so the seller knows exactly what to check.`;

export function buildExtractionPrompt(opts: {
  sellerNotes?: string;
  categoryHint?: string;
  imageRoles: string[];
}): string {
  const parts: string[] = [];

  parts.push(
    `You are looking at ${opts.imageRoles.length} photograph${opts.imageRoles.length === 1 ? '' : 's'} of ONE item.`,
  );

  if (opts.imageRoles.length > 0) {
    parts.push(
      `In order, the seller labelled them: ${opts.imageRoles
        .map((role, i) => `image ${i + 1} = ${role}`)
        .join(', ')}.`,
    );
  }

  if (opts.categoryHint) {
    parts.push(
      `The previous item in this batch was a ${opts.categoryHint}. That is weak context only — this item may be completely different, so do not let it steer you.`,
    );
  }

  if (opts.sellerNotes) {
    parts.push(
      `The seller said: "${opts.sellerNotes}"\n\nTreat this as ground truth where it conflicts with what you think you see. They are holding the garment; you are looking at a photograph of it.`,
    );
  }

  parts.push('Return the structured attributes now.');
  return parts.join('\n\n');
}

export const COPY_SYSTEM = `You write listings for secondhand clothing that sell, without overclaiming.

You are given verified attributes read off the garment. Your job is to turn them into a title, bullets, a description, and search keywords.

What good looks like here:

- SPECIFIC BEATS ENTHUSIASTIC. "Heavyweight 12oz cotton, boxy fit, single-stitch hems" outsells "AMAZING vintage tee!!". Buyers of secondhand clothing are looking for facts that tell them whether it will fit and whether it is real.

- NEVER INVENT. Do not add a decade, a country of manufacture, a fabric, a fit, or a provenance story that is not in the attributes you were given. If the attributes say nothing about era, say nothing about era.

- TITLE TOKENS ARE RANKED, NOT A SENTENCE. Return them ordered by how much a buyer would search for them. Brand first, then the distinguishing feature, then the item type, then size. Downstream code drops from the end to fit each marketplace's character limit, so anything essential must be near the front.

- KEYWORDS ARE FOR SEARCH, NOT FOR SHOWING. Lowercase, no repeats, no filler like "clothing" or "fashion". Think about what someone types into a search box when they want this exact thing.

- DISCLOSE FLAWS PLAINLY. Copy the disclosure sentences you were given. Do not soften them. A flaw disclosed is a return avoided.

- NO EMOJI, NO ALL-CAPS, NO HTML. Downstream code adapts tone and formatting per marketplace.`;

export function buildCopyPrompt(opts: {
  attributes: ExtractedAttributes;
  compTitles?: string[];
  targetPlatforms?: PlatformId[];
  sellerNotes?: string;
}): string {
  const parts: string[] = [];

  parts.push('Verified attributes for this item:');
  parts.push('```json\n' + JSON.stringify(stripNoise(opts.attributes), null, 2) + '\n```');

  if (opts.compTitles?.length) {
    parts.push(
      `Titles of comparable items that actually sold recently. Match their vocabulary where it fits — these are the words real buyers searched:\n${opts.compTitles
        .slice(0, 8)
        .map((t) => `- ${t}`)
        .join('\n')}`,
    );
  }

  if (opts.targetPlatforms?.length) {
    const tightest = opts.targetPlatforms.reduce((min, id) => {
      const chars = getPlatform(id).title.maxChars;
      return chars < min ? chars : min;
    }, Number.MAX_SAFE_INTEGER);
    parts.push(
      `This will be adapted for: ${opts.targetPlatforms.map((p) => getPlatform(p).label).join(', ')}. ` +
        `The tightest title limit is ${tightest} characters, so the first two or three title tokens have to carry the listing on their own.`,
    );
  }

  if (opts.sellerNotes) {
    parts.push(`The seller added: "${opts.sellerNotes}" — work this in if it is relevant.`);
  }

  if (opts.attributes.defects.length > 0) {
    parts.push(
      `This item has ${opts.attributes.defects.length} recorded flaw${opts.attributes.defects.length === 1 ? '' : 's'}. Every one must appear in disclosures, worded as given.`,
    );
  }

  if (opts.attributes.confidence < 0.7) {
    parts.push(
      `Extraction confidence is ${opts.attributes.confidence.toFixed(2)}, which is low. Write around the fields you were actually given and do not compensate for the gaps by inventing detail.`,
    );
  }

  parts.push('Write the listing now.');
  return parts.join('\n\n');
}

/** Drop empty fields so the model is not distracted by a wall of nulls. */
function stripNoise(attrs: ExtractedAttributes): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}
