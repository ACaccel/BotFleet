/**
 * Unit tests for {@link runSocialLinkPreview}: provider routing, the
 * preview cap, and the silent-failure contract (Err logged + skipped,
 * null skipped, unmatched ignored, a withdrawn message ends the pass at
 * debug level). Uses a fake registry and a fake Message that records
 * replies and suppression calls.
 */
import { describe, expect, it, vi } from 'vitest';
import { DiscordAPIError, type Message } from 'discord.js';

import { runSocialLinkPreview } from '../../../../src/plugins/social-link-preview/internal/orchestrator';
import type { Logger } from '../../../../src/core/logger';
import type { Translator } from '../../../../src/core/i18n';
import type {
  LinkPreviewProvider,
  LinkPreviewProviderRegistry,
  LinkPreviewResult,
  LinkPreviewFailure,
} from '../../../../src/infra/link-preview';
import { ok, err, type Result } from '../../../../src/core/result';
import { invalidResponseError } from '../../../../src/infra/link-preview';

const makeLogger = (): Logger => {
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger as unknown as Logger;
};

const translator = { t: vi.fn((key: string) => key) } as unknown as Translator;

const makeMessage = (content: string) => {
  const replies: unknown[] = [];
  const calls = { suppress: 0 };
  const message = {
    content,
    guildId: 'g1',
    channelId: 'c1',
    reply: vi.fn(async (payload: unknown) => {
      replies.push(payload);
      return {} as Message;
    }),
    inGuild: () => true,
    client: { user: { id: 'bot' } },
    channel: { permissionsFor: () => ({ has: () => true }) },
    suppressEmbeds: vi.fn(async () => {
      calls.suppress += 1;
    }),
    delete: vi.fn(async () => {}),
  };
  return { message: message as unknown as Message, replies, calls };
};

const stubProvider = (
  result: Result<LinkPreviewResult | null, LinkPreviewFailure>,
): LinkPreviewProvider => ({
  name: 'twitter',
  canHandle: () => true,
  build: vi.fn(async () => result),
});

const registryReturning = (
  provider: LinkPreviewProvider | undefined,
): LinkPreviewProviderRegistry =>
  ({ findProvider: vi.fn(() => provider) }) as unknown as LinkPreviewProviderRegistry;

const config = {
  originalMessageStrategy: 'suppress' as const,
  timeoutMs: 1000,
  maxVideoBytes: 8 * 1024 * 1024,
  videoTimeoutMs: 15_000,
  maxUrlsPerMessage: 1,
};

const rewritten: LinkPreviewResult = {
  kind: 'rewritten-url',
  url: 'https://fxtwitter.com/a/status/1',
  sourceUrl: 'https://x.com/a/status/1',
};

describe('runSocialLinkPreview', () => {
  it('renders a preview and applies the suppress strategy on a match', async () => {
    const { message, replies, calls } = makeMessage('see https://x.com/a/status/1');
    const registry = registryReturning(stubProvider(ok(rewritten)));
    await runSocialLinkPreview({ registry, config, translator, logger: makeLogger() }, message);

    expect(replies).toHaveLength(1);
    expect(calls.suppress).toBe(1);
  });

  it('does nothing when no provider matches', async () => {
    const { message, replies, calls } = makeMessage('see https://x.com/a/status/1');
    const registry = registryReturning(undefined);
    await runSocialLinkPreview({ registry, config, translator, logger: makeLogger() }, message);

    expect(replies).toHaveLength(0);
    expect(calls.suppress).toBe(0);
  });

  it('logs and skips a provider Err without replying', async () => {
    const { message, replies } = makeMessage('see https://x.com/a/status/1');
    const registry = registryReturning(stubProvider(err(invalidResponseError('twitter'))));
    const logger = makeLogger();
    await runSocialLinkPreview({ registry, config, translator, logger }, message);

    expect(replies).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('skips silently when the provider returns null (matched but not previewable)', async () => {
    const { message, replies } = makeMessage('see https://x.com/a/status/1');
    const registry = registryReturning(stubProvider(ok(null)));
    const logger = makeLogger();
    await runSocialLinkPreview({ registry, config, translator, logger }, message);

    expect(replies).toHaveLength(0);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('does nothing when the message has no URL', async () => {
    const { message, replies } = makeMessage('no links here');
    const registry = registryReturning(stubProvider(ok(rewritten)));
    await runSocialLinkPreview({ registry, config, translator, logger: makeLogger() }, message);
    expect(replies).toHaveLength(0);
  });

  it('caps previews at maxUrlsPerMessage', async () => {
    const { message, replies } = makeMessage('https://x.com/a/status/1 https://x.com/b/status/2');
    const registry = registryReturning(stubProvider(ok(rewritten)));
    await runSocialLinkPreview(
      { registry, config: { ...config, maxUrlsPerMessage: 1 }, translator, logger: makeLogger() },
      message,
    );
    expect(replies).toHaveLength(1);
  });

  it('renders up to maxUrlsPerMessage previews when several URLs match (cap as a floor)', async () => {
    const { message, replies, calls } = makeMessage(
      'https://x.com/a/status/1 https://x.com/b/status/2',
    );
    const registry = registryReturning(stubProvider(ok(rewritten)));
    await runSocialLinkPreview(
      { registry, config: { ...config, maxUrlsPerMessage: 2 }, translator, logger: makeLogger() },
      message,
    );
    expect(replies).toHaveLength(2);
    expect(calls.suppress).toBe(2);
  });

  it('isolates a reply failure on one URL so later URLs still preview', async () => {
    const { message, replies } = makeMessage('https://x.com/a/status/1 https://x.com/b/status/2');
    let first = true;
    const message2 = {
      ...(message as unknown as Record<string, unknown>),
      reply: vi.fn(async (payload: unknown) => {
        if (first) {
          first = false;
          throw new Error('rate limited');
        }
        replies.push(payload);
        return {} as Message;
      }),
    } as unknown as Message;
    const registry = registryReturning(stubProvider(ok(rewritten)));
    const logger = makeLogger();
    await runSocialLinkPreview(
      { registry, config: { ...config, maxUrlsPerMessage: 2 }, translator, logger },
      message2,
    );
    // First reply threw and was logged; the second URL still produced a preview.
    expect(replies).toHaveLength(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('ends the pass at debug level when the message was deleted before the reply', async () => {
    const { message, replies, calls } = makeMessage(
      'https://x.com/a/status/1 https://x.com/b/status/2',
    );
    const withdrawn = new DiscordAPIError(
      {
        message: 'Invalid Form Body',
        code: 50035,
        errors: {
          message_reference: {
            _errors: [{ code: 'MESSAGE_REFERENCE_UNKNOWN_MESSAGE', message: 'Unknown message' }],
          },
        },
      },
      50035,
      400,
      'POST',
      'https://discord.test/channels/c1/messages',
      {},
    );
    const message2 = {
      ...(message as unknown as Record<string, unknown>),
      reply: vi.fn(async () => {
        throw withdrawn;
      }),
    } as unknown as Message;
    const provider = stubProvider(ok(rewritten));
    const registry = registryReturning(provider);
    const logger = makeLogger();
    await runSocialLinkPreview(
      { registry, config: { ...config, maxUrlsPerMessage: 2 }, translator, logger },
      message2,
    );
    // No preview, no suppression, no error line; the second URL was never probed.
    expect(replies).toHaveLength(0);
    expect(calls.suppress).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(provider.build).toHaveBeenCalledTimes(1);
  });
});
