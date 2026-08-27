/**
 * @tagged/ai — model access behind one interface.
 *
 * The rule this package exists to enforce: no vendor SDK is imported anywhere
 * else in the codebase. Swapping Gemini for Claude, or adding a third
 * provider, is a change inside these files and a line in .env — never a
 * refactor of the pipeline.
 */

export * from './provider';
export * from './router';
export { GeminiProvider } from './gemini';
export { AnthropicProvider } from './anthropic';
export { ATTRIBUTES_SCHEMA, LISTING_CORE_SCHEMA } from './schemas';
export { normalizeAttributes, normalizeListingCore } from './normalize';
export { EXTRACTION_SYSTEM, COPY_SYSTEM, buildExtractionPrompt, buildCopyPrompt } from './prompts';
