import type { ExtractedAttributes, ListingCore, PlatformId } from '@tagged/core';

/**
 * The provider interface.
 *
 * This exists so that "which AI platform should we use" is a config value
 * rather than an architectural commitment. Providers change pricing, deprecate
 * models, and change their terms of service; when that happens the fix should
 * be one line in an env file, not a refactor.
 *
 * Nothing outside this package should import a vendor SDK directly.
 */

export interface ImageInput {
  /** e.g. "image/webp", "image/jpeg" */
  mimeType: string;
  /** Base64, no data: prefix. */
  data: string;
  /** Optional hint about what this frame shows — improves extraction a lot. */
  role?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Computed from the model's rate card. Used to enforce per-user budgets. */
  costUsd: number;
  model: string;
  provider: string;
}

export interface ExtractRequest {
  images: ImageInput[];
  /** Anything the seller typed or dictated. Trusted over the model's guess. */
  sellerNotes?: string;
  /** Category hint from a previous item in the same batch shoot. */
  categoryHint?: string;
}

export interface ExtractResult {
  attributes: ExtractedAttributes;
  usage: Usage;
}

export interface WriteListingRequest {
  attributes: ExtractedAttributes;
  /** Titles of comparable listings that actually sold — strong style signal. */
  compTitles?: string[];
  /** Platforms this will be adapted for, so the copy suits the shortest limit. */
  targetPlatforms?: PlatformId[];
  sellerNotes?: string;
}

export interface WriteListingResult {
  core: ListingCore;
  usage: Usage;
}

export interface LLMProvider {
  readonly name: string;
  readonly visionModel: string;
  readonly copyModel: string;

  /** Stage 1: read the photos into a structured attribute set. */
  extractAttributes(request: ExtractRequest): Promise<ExtractResult>;

  /** Stage 4: write the platform-neutral listing core. */
  writeListing(request: WriteListingRequest): Promise<WriteListingResult>;
}

export class AIProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'AIProviderError';
  }
}

export class BudgetExceededError extends Error {
  constructor(readonly spentUsd: number, readonly limitUsd: number) {
    super(
      `Monthly AI budget reached ($${spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)}). ` +
        `Listings can still be written by hand.`,
    );
    this.name = 'BudgetExceededError';
  }
}

// ---------------------------------------------------------------------------
// Rate card
// ---------------------------------------------------------------------------

export interface ModelRate {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * Prices in USD per million tokens, checked 2026-08-26. These move — the
 * budget guard degrades gracefully if a model is missing, but re-check them
 * when you change models.
 *
 * NOTE: `gemini-2.5-flash-lite` is the cheapest entry here but Google has
 * closed it to new API keys — a fresh key gets a 404 telling you to move to a
 * 3.x model. It stays in the table so existing keys still cost correctly, but
 * the default is `gemini-3.1-flash-lite`, the cheapest model a new key can
 * actually reach.
 */
export const MODEL_RATES: Record<string, ModelRate> = {
  // Google
  'gemini-2.5-flash-lite': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  'gemini-2.5-flash': { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  'gemini-3.1-flash-lite': { inputPerMillion: 0.25, outputPerMillion: 1.5 },
  'gemini-3.5-flash-lite': { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  // Anthropic
  'claude-haiku-4-5': { inputPerMillion: 1.0, outputPerMillion: 5.0 },
  'claude-sonnet-5': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'claude-opus-5': { inputPerMillion: 5.0, outputPerMillion: 25.0 },
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const rate = MODEL_RATES[model];
  if (!rate) return 0;
  return (
    (inputTokens / 1_000_000) * rate.inputPerMillion +
    (outputTokens / 1_000_000) * rate.outputPerMillion
  );
}
