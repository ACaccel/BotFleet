import type { FeedPlatformId } from './types';

/** Platform capabilities drive the editor and reject irrelevant filter values. */
export interface FeedFilterCapabilities {
  readonly media: boolean;
}

const CAPABILITIES: Readonly<Record<FeedPlatformId, FeedFilterCapabilities>> = {
  x: { media: true },
  bahamut: { media: true },
  youtube: { media: false },
};

export const feedFilterCapabilities = (platform: string): FeedFilterCapabilities =>
  Object.hasOwn(CAPABILITIES, platform)
    ? CAPABILITIES[platform as FeedPlatformId]
    : { media: true };
