/**
 * Unit tests for {@link runSocialLinkPreview}: provider routing, the
 * preview cap, and the silent-failure contract (Err logged + skipped,
 * null skipped, unmatched ignored, a withdrawn message ends the pass at
 * debug level). Uses a fake registry and a fake Message that records
 * replies and suppression calls.
 */
import { describe, expect, it, vi } from 'vitest';
import { DiscordAPIError } from 'discord.js';

import { runSocialLinkPreview } from '../../../../src/plugins/social-link-preview/internal/orchestrator';
import type {
  Gallery,
  LinkPreviewProvider,
  LinkPreviewResult,
  LinkPreviewFailure,
} from '../../../../src/infra/link-preview';
import type { GalleryPageOutcome } from '../../../../src/application/gallery-reader/service';
import { ok, err, type Result } from '../../../../src/core/result';
import {
  invalidResponseError,
  LinkPreviewProviderRegistry,
} from '../../../../src/infra/link-preview';
import { buildMessage } from '../../../fixtures/discord/message-builder';
import { echoTranslator, silentLogger, spyLogger } from '../../../fixtures/runtime';

const translator = echoTranslator();

interface MessageOpts {
  /** Returns the error the n-th reply (1-based) rejects with, or `undefined` to let it send. */
  readonly failReply?: (attempt: number) => unknown;
}

const makeMessage = (content: string, opts: MessageOpts = {}) => {
  const replies: unknown[] = [];
  const calls = { suppress: 0 };
  let attempts = 0;
  const message = buildMessage({
    content,
    reply: vi.fn(async (payload: unknown) => {
      attempts += 1;
      const failure = opts.failReply?.(attempts);
      if (failure !== undefined) throw failure;
      replies.push(payload);
      return {};
    }),
    inGuild: () => true,
    client: { user: { id: 'bot' } },
    channel: { permissionsFor: () => ({ has: () => true }) },
    suppressEmbeds: vi.fn(async () => {
      calls.suppress += 1;
    }),
    delete: vi.fn(async () => {}),
  });
  return { message, replies, calls };
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
  new LinkPreviewProviderRegistry(provider === undefined ? [] : [provider]);

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
    await runSocialLinkPreview({ registry, config, translator, logger: silentLogger() }, message);

    expect(replies).toHaveLength(1);
    expect(calls.suppress).toBe(1);
  });

  it('does nothing when no provider matches', async () => {
    const { message, replies, calls } = makeMessage('see https://x.com/a/status/1');
    const registry = registryReturning(undefined);
    await runSocialLinkPreview({ registry, config, translator, logger: silentLogger() }, message);

    expect(replies).toHaveLength(0);
    expect(calls.suppress).toBe(0);
  });

  it('logs and skips a provider Err without replying', async () => {
    const { message, replies } = makeMessage('see https://x.com/a/status/1');
    const registry = registryReturning(stubProvider(err(invalidResponseError('twitter'))));
    const logger = spyLogger();
    const { error } = logger;
    await runSocialLinkPreview({ registry, config, translator, logger }, message);

    expect(replies).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('skips silently when the provider returns null (matched but not previewable)', async () => {
    const { message, replies } = makeMessage('see https://x.com/a/status/1');
    const registry = registryReturning(stubProvider(ok(null)));
    const logger = spyLogger();
    const { error } = logger;
    await runSocialLinkPreview({ registry, config, translator, logger }, message);

    expect(replies).toHaveLength(0);
    expect(error).not.toHaveBeenCalled();
  });

  it('does nothing when the message has no URL', async () => {
    const { message, replies } = makeMessage('no links here');
    const registry = registryReturning(stubProvider(ok(rewritten)));
    await runSocialLinkPreview({ registry, config, translator, logger: silentLogger() }, message);
    expect(replies).toHaveLength(0);
  });

  it('caps previews at maxUrlsPerMessage', async () => {
    const { message, replies } = makeMessage('https://x.com/a/status/1 https://x.com/b/status/2');
    const registry = registryReturning(stubProvider(ok(rewritten)));
    await runSocialLinkPreview(
      { registry, config: { ...config, maxUrlsPerMessage: 1 }, translator, logger: silentLogger() },
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
      { registry, config: { ...config, maxUrlsPerMessage: 2 }, translator, logger: silentLogger() },
      message,
    );
    expect(replies).toHaveLength(2);
    expect(calls.suppress).toBe(2);
  });

  it('isolates a reply failure on one URL so later URLs still preview', async () => {
    const { message, replies } = makeMessage('https://x.com/a/status/1 https://x.com/b/status/2', {
      failReply: (attempt) => (attempt === 1 ? new Error('rate limited') : undefined),
    });
    const registry = registryReturning(stubProvider(ok(rewritten)));
    const logger = spyLogger();
    const { error } = logger;
    await runSocialLinkPreview(
      { registry, config: { ...config, maxUrlsPerMessage: 2 }, translator, logger },
      message,
    );
    // First reply threw and was logged; the second URL still produced a preview.
    expect(replies).toHaveLength(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('ends the pass at debug level when the message was deleted before the reply', async () => {
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
    const { message, replies, calls } = makeMessage(
      'https://x.com/a/status/1 https://x.com/b/status/2',
      { failReply: () => withdrawn },
    );
    const provider = stubProvider(ok(rewritten));
    const registry = registryReturning(provider);
    const logger = spyLogger();
    const { error, debug } = logger;
    await runSocialLinkPreview(
      { registry, config: { ...config, maxUrlsPerMessage: 2 }, translator, logger },
      message,
    );
    // No preview, no suppression, no error line; the second URL was never probed.
    expect(replies).toHaveLength(0);
    expect(calls.suppress).toBe(0);
    expect(error).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
    expect(provider.build).toHaveBeenCalledTimes(1);
  });
});

describe('runSocialLinkPreview gallery links', () => {
  const gallery: Gallery = {
    source: 'nhentai',
    id: '1',
    url: 'https://nhentai.net/g/1/',
    title: 'Title',
    tags: [],
    pages: [{ urls: ['https://i1.nhentai.net/galleries/9/1.webp'] }],
  };
  const galleryResult: LinkPreviewResult = {
    kind: 'gallery',
    gallery,
    startPage: 1,
    sourceUrl: 'https://nhentai.net/g/1/',
  };
  const galleryProvider = (): LinkPreviewProvider => ({
    name: 'nhentai',
    canHandle: () => true,
    build: vi.fn(async () => ok(galleryResult)),
  });
  const fakeReader = (outcome: GalleryPageOutcome) => ({
    remember: vi.fn(),
    loadPage: vi.fn(async () => outcome),
  });
  const loaded: GalleryPageOutcome = {
    status: 'ok',
    gallery,
    page: 1,
    media: { kind: 'file', image: { data: Buffer.from([1]), extension: 'webp' } },
  };
  const galleryMessage = (nsfw: boolean) => {
    const built = makeMessage('https://nhentai.net/g/1/');
    Object.assign(built.message, {
      channel: { isThread: () => false, nsfw, permissionsFor: () => ({ has: () => true }) },
    });
    return built;
  };

  it('posts a reader message with the page attached in an age-restricted channel', async () => {
    const { message, replies, calls } = galleryMessage(true);
    const reader = fakeReader(loaded);
    await runSocialLinkPreview(
      {
        registry: registryReturning(galleryProvider()),
        config,
        translator,
        logger: silentLogger(),
        galleryReader: reader,
      },
      message,
    );

    expect(reader.remember).toHaveBeenCalledWith(gallery);
    expect(reader.loadPage).toHaveBeenCalledWith('nhentai', '1', 1);
    expect(replies).toHaveLength(1);
    expect((replies[0] as { files: unknown[] }).files).toHaveLength(1);
    expect(calls.suppress).toBe(1);
  });

  it('never fetches a gallery outside an age-restricted channel or without a reader', async () => {
    const provider = galleryProvider();
    const sfw = galleryMessage(false);
    await runSocialLinkPreview(
      {
        registry: registryReturning(provider),
        config,
        translator,
        logger: silentLogger(),
        galleryReader: fakeReader(loaded),
      },
      sfw.message,
    );
    const noReader = galleryMessage(true);
    await runSocialLinkPreview(
      { registry: registryReturning(provider), config, translator, logger: silentLogger() },
      noReader.message,
    );

    expect(provider.build).not.toHaveBeenCalled();
    expect(sfw.replies).toHaveLength(0);
    expect(noReader.replies).toHaveLength(0);
  });

  it('leaves the original message alone when the page cannot be loaded', async () => {
    const { message, replies, calls } = galleryMessage(true);
    await runSocialLinkPreview(
      {
        registry: registryReturning(galleryProvider()),
        config,
        translator,
        logger: silentLogger(),
        galleryReader: fakeReader({ status: 'unavailable' }),
      },
      message,
    );

    expect(replies).toHaveLength(0);
    expect(calls.suppress).toBe(0);
  });
});
