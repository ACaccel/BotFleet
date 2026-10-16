/**
 * FeedPlatformRegistry — Strategy lookup by platform id.
 *
 * Shaped after {@link LinkPreviewProviderRegistry}: the platforms are
 * copied into a read-only array at construction, and a miss returns
 * `undefined` rather than throwing. A miss is an ordinary outcome here —
 * a command names a platform the operator never configured — and the
 * caller owns the user-facing message, so raising would only force a
 * try/catch at every call site.
 *
 * Platforms hold no secrets, so they are stored as ready instances
 * rather than deferred factories.
 */
import type { FeedPlatform } from './types';

export class FeedPlatformRegistry {
  private readonly platforms: readonly FeedPlatform[];

  public constructor(platforms: Iterable<FeedPlatform>) {
    this.platforms = [...platforms];
    const ids = this.platforms.map((platform) => platform.id);
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate !== undefined) {
      // A programmer error in the composition root, not an operator
      // mistake: `get` would silently answer with the first, so which
      // of two identically-named platforms serves a subscription would
      // depend on registration order. Native TypeError is the right
      // channel — this never travels a Result rail.
      throw new TypeError(`FeedPlatformRegistry: duplicate platform id "${duplicate}"`);
    }
  }

  /** The registered platform with this id, or `undefined` when none is. */
  public get(id: string): FeedPlatform | undefined {
    return this.platforms.find((platform) => platform.id === id);
  }
}
