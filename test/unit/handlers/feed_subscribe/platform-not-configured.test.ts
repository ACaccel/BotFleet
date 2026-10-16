/**
 * The refusal raised for a platform this bot has no adapter for.
 *
 * It is a `FeedError` rather than a hand-rendered reply so the failure
 * is logged as well as shown. The display-name fallback it renders
 * through is covered by `feed-platform-name.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { DomainError } from '../../../../src/core/errors';
import { platformNotConfiguredError } from '../../../../src/handlers/commands/feed_subscribe/platform-not-configured';
import { FEED_PLATFORM_DISPLAY_NAMES } from '../../../../src/infra/social-feed';

describe('platformNotConfiguredError', () => {
  it('is a DomainError, so the boundary logs it and renders its own copy', () => {
    const error = platformNotConfiguredError('x');

    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe('FEED_PLATFORM_NOT_CONFIGURED');
    expect(error.messageKey).toBe('errors:feed.platform_not_configured');
  });

  it('names the platform the way the catalog expects', () => {
    expect(platformNotConfiguredError('x').messageParams.platform).toBe(
      FEED_PLATFORM_DISPLAY_NAMES.x,
    );
  });

  it('keeps the raw id in the operator context', () => {
    // The user sees a display name; whoever edits `config.json` needs
    // the key they would actually type.
    expect(platformNotConfiguredError('bluesky').context?.input).toEqual({ platform: 'bluesky' });
  });
});
