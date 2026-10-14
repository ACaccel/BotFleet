/**
 * Configuration schema and defaults for the LLM auto-reply plugin.
 *
 * Defaults live here in code (zod `.default()`), so a bot may declare an
 * empty / partial `llm_auto_reply` block in its `config.json` and still
 * boot with a fully-formed, safe (disabled) configuration. `.strict()`
 * surfaces a mistyped key at startup rather than silently ignoring it.
 */
import { z } from 'zod';

/**
 * Non-functional placeholder endpoint. The plugin no-ops while
 * `enabled` is false (the default), so an unconfigured deployment never
 * dials a real host; an operator sets the real URL in `config.json`.
 */
const DEFAULT_ENDPOINT = 'https://localhost/chat';
/** Discord's `messages.fetch` ceiling — also the sane upper bound for N. */
const MAX_MESSAGE_COUNT = 100;
/** Hard cap so a typo cannot hold a request open for minutes. */
const MAX_TIMEOUT_MS = 60_000;

const ConfigSchema = z
  .object({
    /** Master switch. Off by default so the feature is strictly opt-in. */
    enabled: z.boolean().default(false),
    /** Per-message chance (0..1) of attempting a reply. */
    probability: z.number().min(0).max(1).default(0.05),
    /** How many recent messages (N) to fetch and require for context. */
    messageCount: z.number().int().positive().max(MAX_MESSAGE_COUNT).default(5),
    /** The burst window (M), in seconds: the N messages must span <= this. */
    windowSeconds: z.number().positive().default(30),
    /**
     * Minimum seconds between two consecutive replies in the same channel.
     * `0` disables the cooldown. An @-mention reply skips this check but
     * still records its timestamp, so a following automatic reply observes
     * the gap.
     */
    cooldownSeconds: z.number().min(0).default(30),
    /** Self-hosted LLM chat endpoint URL. */
    endpoint: z.string().url().default(DEFAULT_ENDPOINT),
    /** Per-request HTTP timeout in milliseconds. */
    timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).default(10_000),
  })
  .strict();

export type LlmAutoReplyPluginConfig = z.infer<typeof ConfigSchema>;

/** An absent block yields the disabled defaults. */
export const parseLlmAutoReplyConfig = (raw: unknown): LlmAutoReplyPluginConfig =>
  ConfigSchema.parse(raw ?? {});
