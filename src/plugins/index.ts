/**
 * Plugin barrel.
 *
 * Bot composition roots import from this barrel via the `@plugins`
 * alias so a `bot.use(createAutoReplyPlugin(...))` line stays a single readable
 * statement. Internal plugin modules continue to import each other by
 * relative path; only the public-facing plugin exports surface here.
 */
export { createAutoReplyPlugin } from './auto-reply';
export { createGuildEventsPlugin } from './guild-events';
export { createGiveawayPlugin } from './giveaway';
export { createTempRolePlugin } from './temp-role';
export { createActivityPlugin } from './activity';
export { createMessageBackupPlugin } from './message-backup';
export { createLlmChatPlugin } from './llm-chat';
export { createEarthquakePlugin } from './earthquake';
export { createLlmAutoReplyPlugin } from './llm-auto-reply';
export { createSocialLinkPreviewPlugin } from './social-link-preview';
export { createSettingsApiPlugin } from './settings-api';
export { createIdentitySyncPlugin } from './identity-sync';
export { createSocialFeedPlugin } from './social-feed';
