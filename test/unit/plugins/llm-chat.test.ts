/**
 * LlmChatPlugin dependency wiring.
 *
 * The chat pipeline itself (sessions, chunking, usage footer) is
 * exercised through `llm-chat-session-manager.test.ts` and the LLM
 * contract suite. What is pinned here is the one invariant the plugin
 * enforces itself: `init` builds the runtime, and a `messageCreate`
 * that somehow arrives first must raise rather than degrade — the
 * missing dependency is the whitelist gate, so a silent no-op would be
 * indistinguishable from "user is not whitelisted".
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_RATE_LIMIT } from '../../../src/application/ai/policy';
import { createLlmChatPlugin } from '../../../src/plugins/llm-chat';
import { buildMessage } from '../../fixtures/discord/message-builder';
import { buildPluginContext } from '../../fixtures/runtime';

describe('createLlmChatPlugin dependency wiring', () => {
  it('refuses to run an event that somehow precedes init', async () => {
    const handler = createLlmChatPlugin({
      clientId: 'bot-1',
      policy: { rateLimit: DEFAULT_RATE_LIMIT },
      isAdmin: () => false,
    }).events?.messageCreate;
    if (handler === undefined) throw new Error('llm-chat must subscribe to messageCreate');

    await expect(handler(buildPluginContext(), buildMessage() as never)).rejects.toThrow(
      /dispatched before init/,
    );
  });
});
