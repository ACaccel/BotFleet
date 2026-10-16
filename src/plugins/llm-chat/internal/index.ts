/**
 * Plugin-private barrel for llm-chat. Re-exports the in-memory
 * `SessionManager` so the plugin file imports it from a single
 * location. LLM provider knowledge (catalog, pricing, types,
 * Strategy registry) lives in `src/infra/llm/**` and is imported
 * directly from there.
 */
export { SessionManager } from './session-manager';
export { gateChatRequest, releaseChatRequest } from './gate';
