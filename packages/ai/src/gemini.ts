import { normalizeAttributes, normalizeListingCore, parseJsonLoose } from './normalize';
import { buildCopyPrompt, buildExtractionPrompt, COPY_SYSTEM, EXTRACTION_SYSTEM } from './prompts';
import { AIProviderError, estimateCost } from './provider';
import type {
  ExtractRequest,
  ExtractResult,
  LLMProvider,
  Usage,
  WriteListingRequest,
  WriteListingResult,
} from './provider';
import { ATTRIBUTES_SCHEMA, LISTING_CORE_SCHEMA } from './schemas';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string; status?: string };
}

export interface GeminiOptions {
  apiKey: string;
  visionModel?: string;
  copyModel?: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Google Gemini via the REST API.
 *
 * Raw fetch rather than the SDK so this runs unchanged on Node, on Cloudflare
 * Workers, and in an edge runtime, with no bundle weight.
 */
export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  readonly visionModel: string;
  readonly copyModel: string;

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeminiOptions) {
    if (!options.apiKey) {
      throw new AIProviderError('GEMINI_API_KEY is not set.', 'gemini');
    }
    this.apiKey = options.apiKey;
    this.visionModel = options.visionModel ?? 'gemini-2.5-flash-lite';
    this.copyModel = options.copyModel ?? 'gemini-2.5-flash-lite';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async extractAttributes(request: ExtractRequest): Promise<ExtractResult> {
    if (request.images.length === 0) {
      throw new AIProviderError('At least one photo is required to identify an item.', 'gemini');
    }

    const parts: GeminiPart[] = [];
    for (const image of request.images) {
      parts.push({ inline_data: { mime_type: image.mimeType, data: image.data } });
    }
    parts.push({
      text: buildExtractionPrompt({
        sellerNotes: request.sellerNotes,
        categoryHint: request.categoryHint,
        imageRoles: request.images.map((i) => i.role ?? 'unspecified'),
      }),
    });

    const { json, usage } = await this.generate(this.visionModel, EXTRACTION_SYSTEM, parts, ATTRIBUTES_SCHEMA);
    return { attributes: normalizeAttributes(json), usage };
  }

  async writeListing(request: WriteListingRequest): Promise<WriteListingResult> {
    const parts: GeminiPart[] = [{ text: buildCopyPrompt(request) }];
    const { json, usage } = await this.generate(this.copyModel, COPY_SYSTEM, parts, LISTING_CORE_SCHEMA);
    return { core: normalizeListingCore(json, request.attributes), usage };
  }

  private async generate(
    model: string,
    system: string,
    parts: GeminiPart[],
    schema: unknown,
  ): Promise<{ json: unknown; usage: Usage }> {
    const url = `${API_BASE}/models/${model}:generateContent`;

    const body = {
      contents: [{ role: 'user', parts }],
      systemInstruction: { parts: [{ text: system }] },
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: schema,
      },
    };

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new AIProviderError(
        `Could not reach Gemini: ${cause instanceof Error ? cause.message : String(cause)}`,
        'gemini',
        undefined,
        true,
      );
    }

    const payload = (await response.json().catch(() => ({}))) as GeminiResponse;

    if (!response.ok) {
      const message = payload.error?.message ?? `HTTP ${response.status}`;
      // 429 and 5xx are worth retrying; 400 and 403 are configuration problems.
      const retryable = response.status === 429 || response.status >= 500;
      throw new AIProviderError(`Gemini rejected the request: ${message}`, 'gemini', response.status, retryable);
    }

    const candidate = payload.candidates?.[0];
    if (candidate?.finishReason === 'SAFETY' || candidate?.finishReason === 'PROHIBITED_CONTENT') {
      throw new AIProviderError(
        'Gemini declined to analyse these photos. Retake them showing only the item.',
        'gemini',
        response.status,
      );
    }

    const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text) {
      throw new AIProviderError('Gemini returned an empty response.', 'gemini', response.status, true);
    }

    const inputTokens = payload.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = payload.usageMetadata?.candidatesTokenCount ?? 0;

    return {
      json: parseJsonLoose(text),
      usage: {
        inputTokens,
        outputTokens,
        costUsd: estimateCost(model, inputTokens, outputTokens),
        model,
        provider: 'gemini',
      },
    };
  }
}
