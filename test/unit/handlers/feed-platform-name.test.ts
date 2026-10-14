/**
 * The display-name fallback both `/feed_*` commands rely on.
 *
 * It is what stops a platform from being named by its raw registry id
 * in the one message the registry cannot answer for — the refusal for
 * an unconfigured platform, and the labels on `/feed unsubscribe`'s
 * account suggestions.
 */
import { describe, expect, it } from 'vitest';

import { feedPlatformDisplayName } from '../../../src/handlers/feed-platform-name';
import {
  FEED_PLATFORM_DISPLAY_NAMES,
  SUPPORTED_FEED_PLATFORMS,
} from '../../../src/infra/social-feed';

describe('feedPlatformDisplayName', () => {
  it('ships at least one platform, so the sweep below is not vacuous', () => {
    expect(SUPPORTED_FEED_PLATFORMS.length).toBeGreaterThan(0);
  });

  it.each(SUPPORTED_FEED_PLATFORMS)('spells %s the way every other message does', (id) => {
    expect(feedPlatformDisplayName(id)).toBe(FEED_PLATFORM_DISPLAY_NAMES[id]);
  });

  it('echoes an unknown id rather than rendering a blank', () => {
    expect(feedPlatformDisplayName('bluesky')).toBe('bluesky');
  });
});
