import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import { AIProviderError } from './provider';
import type {
  ExtractRequest,
  ExtractResult,
  LLMProvider,
  WriteListingRequest,
  WriteListingResult,
} from './provider';

export type ProviderName = 'gemini' | 'anthropic';

export interface RouterConfig {
  geminiApiKey?: string;
  anthropicApiKey?: string;
  visionProvider?: ProviderName;
  copyProvider?: ProviderName;
  visionModel?: string;
  copyModel?: string;
  /** Used when a caller asks for premium copy on a high-value item. */
  premiumCopyModel?: string;
}

/**
 * Routes each job to whichever provider is configured for it.
 *
 * Vision and copy are separate decisions on purpose. Extraction is
 * high-volume and rewards the cheapest model that reads a care tag reliably;
 * copy is low-volume and rewards a better model. Running Flash-Lite for
 * extraction and Haiku for copy is a perfectly sensible production setup.
 */
export class RoutedProvider implements LLMProvider {
  readonly name = 'routed';

  private readonly vision: LLMProvider;
  private readonly copy: LLMProvider;
  private readonly premium: LLMProvider | null;

  constructor(config: RouterConfig) {
    const visionName = config.visionProvider ?? 'gemini';
    const copyName = config.copyProvider ?? 'gemini';

    this.vision = buildProvider(visionName, config, { visionModel: config.visionModel });
    this.copy =
      copyName === visionName && config.copyModel === config.visionModel
        ? this.vision
        : buildProvider(copyName, config, { copyModel: config.copyModel });

    this.premium =
      config.premiumCopyModel && config.anthropicApiKey
        ? new AnthropicProvider({
            apiKey: config.anthropicApiKey,
            copyModel: config.premiumCopyModel,
          })
        : null;
  }

  get visionModel(): string {
    return this.vision.visionModel;
  }

  get copyModel(): string {
    return this.copy.copyModel;
  }

  extractAttributes(request: ExtractRequest): Promise<ExtractResult> {
    return this.vision.extractAttributes(request);
  }

  writeListing(request: WriteListingRequest): Promise<WriteListingResult> {
    return this.copy.writeListing(request);
  }

  /**
   * Better copy for items where it pays for itself. Falls back silently to the
   * standard model when no premium provider is configured — a missing API key
   * should degrade the listing, not fail the request.
   */
  writePremiumListing(request: WriteListingRequest): Promise<WriteListingResult> {
    return (this.premium ?? this.copy).writeListing(request);
  }

  get hasPremium(): boolean {
    return this.premium !== null;
  }
}

function buildProvider(
  name: ProviderName,
  config: RouterConfig,
  models: { visionModel?: string; copyModel?: string },
): LLMProvider {
  if (name === 'anthropic') {
    if (!config.anthropicApiKey) {
      throw new AIProviderError(
        'AI_*_PROVIDER is set to "anthropic" but ANTHROPIC_API_KEY is missing.',
        'anthropic',
      );
    }
    return new AnthropicProvider({
      apiKey: config.anthropicApiKey,
      visionModel: models.visionModel,
      copyModel: models.copyModel,
    });
  }

  if (!config.geminiApiKey) {
    throw new AIProviderError(
      'GEMINI_API_KEY is missing. Get one at https://aistudio.google.com/apikey.',
      'gemini',
    );
  }
  return new GeminiProvider({
    apiKey: config.geminiApiKey,
    visionModel: models.visionModel,
    copyModel: models.copyModel,
  });
}

/**
 * Retry wrapper for the transient failures that actually happen: rate limits
 * and 5xx. Configuration errors are not retried — hammering a bad API key just
 * makes the log noisier.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 700,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryable = error instanceof AIProviderError && error.retryable;
      if (!retryable || attempt === attempts - 1) throw error;

      const jitter = Math.random() * 250;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt + jitter));
    }
  }

  throw lastError;
}
