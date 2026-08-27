import Anthropic, {
  APIConnectionError,
  APIError,
  RateLimitError,
} from '@anthropic-ai/sdk';

import { normalizeAttributes, normalizeListingCore } from './normalize';
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

export interface AnthropicOptions {
  apiKey: string;
  visionModel?: string;
  copyModel?: string;
}

const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * Anthropic Claude.
 *
 * Positioned as the quality tier: Haiku 4.5 writes noticeably better listing
 * copy than Flash-Lite at roughly six times the cost, which on a $0.001 base
 * is still a rounding error. Route paid users here for the copy call and leave
 * extraction on the cheap model, where OCR accuracy matters more than prose.
 *
 * Structured output uses a forced tool call rather than a response format,
 * because that pattern is stable across every model in the family.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly visionModel: string;
  readonly copyModel: string;

  private readonly client: Anthropic;

  constructor(options: AnthropicOptions) {
    if (!options.apiKey) {
      throw new AIProviderError('ANTHROPIC_API_KEY is not set.', 'anthropic');
    }
    this.client = new Anthropic({ apiKey: options.apiKey });
    this.visionModel = options.visionModel ?? 'claude-haiku-4-5';
    this.copyModel = options.copyModel ?? 'claude-haiku-4-5';
  }

  async extractAttributes(request: ExtractRequest): Promise<ExtractResult> {
    if (request.images.length === 0) {
      throw new AIProviderError('At least one photo is required to identify an item.', 'anthropic');
    }

    const content: Anthropic.ContentBlockParam[] = [];
    for (const image of request.images) {
      if (!SUPPORTED_IMAGE_TYPES.has(image.mimeType)) {
        throw new AIProviderError(
          `Claude cannot read ${image.mimeType} images. Convert to JPEG, PNG or WebP first.`,
          'anthropic',
        );
      }
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: image.data,
        },
      });
    }
    content.push({
      type: 'text',
      text: buildExtractionPrompt({
        sellerNotes: request.sellerNotes,
        categoryHint: request.categoryHint,
        imageRoles: request.images.map((i) => i.role ?? 'unspecified'),
      }),
    });

    const { json, usage } = await this.callTool({
      model: this.visionModel,
      system: EXTRACTION_SYSTEM,
      content,
      toolName: 'record_item_attributes',
      toolDescription: 'Record the structured attributes read from the photographs of this item.',
      schema: ATTRIBUTES_SCHEMA,
      maxTokens: 4096,
    });

    return { attributes: normalizeAttributes(json), usage };
  }

  async writeListing(request: WriteListingRequest): Promise<WriteListingResult> {
    const { json, usage } = await this.callTool({
      model: this.copyModel,
      system: COPY_SYSTEM,
      content: [{ type: 'text', text: buildCopyPrompt(request) }],
      toolName: 'write_listing',
      toolDescription: 'Emit the platform-neutral listing content for this item.',
      schema: LISTING_CORE_SCHEMA,
      maxTokens: 4096,
    });

    return { core: normalizeListingCore(json, request.attributes), usage };
  }

  private async callTool(opts: {
    model: string;
    system: string;
    content: Anthropic.ContentBlockParam[];
    toolName: string;
    toolDescription: string;
    schema: unknown;
    maxTokens: number;
  }): Promise<{ json: unknown; usage: Usage }> {
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create({
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: opts.system,
        messages: [{ role: 'user', content: opts.content }],
        tools: [
          {
            name: opts.toolName,
            description: opts.toolDescription,
            input_schema: opts.schema as Anthropic.Tool.InputSchema,
          },
        ],
        tool_choice: { type: 'tool', name: opts.toolName },
      });
    } catch (cause) {
      // Most-specific first. Collapsing these into one broad catch loses the
      // distinction between "retry in a moment" and "your key is wrong".
      if (cause instanceof RateLimitError) {
        throw new AIProviderError('Claude is rate limited. Try again shortly.', 'anthropic', 429, true);
      }
      if (cause instanceof APIConnectionError) {
        throw new AIProviderError('Could not reach Claude.', 'anthropic', undefined, true);
      }
      if (cause instanceof APIError) {
        const status = typeof cause.status === 'number' ? cause.status : undefined;
        throw new AIProviderError(
          `Claude rejected the request: ${cause.message}`,
          'anthropic',
          status,
          status !== undefined && status >= 500,
        );
      }
      throw new AIProviderError(
        cause instanceof Error ? cause.message : String(cause),
        'anthropic',
        undefined,
        true,
      );
    }

    if (message.stop_reason === 'refusal') {
      throw new AIProviderError(
        'Claude declined to analyse these photos. Retake them showing only the item.',
        'anthropic',
      );
    }

    const toolUse = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );
    if (!toolUse) {
      throw new AIProviderError('Claude did not return structured output.', 'anthropic', undefined, true);
    }

    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;

    return {
      json: toolUse.input,
      usage: {
        inputTokens,
        outputTokens,
        costUsd: estimateCost(opts.model, inputTokens, outputTokens),
        model: opts.model,
        provider: 'anthropic',
      },
    };
  }
}
