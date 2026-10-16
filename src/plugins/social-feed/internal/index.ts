/** Internal barrel for the social-feed plugin. */
export { runFeedPass, type FeedPassDeps } from './poll';
export { selectPostsToForward, type SubscriptionFilter } from './filter';
export { buildFeedMessage, sendFeedPost } from './post';
