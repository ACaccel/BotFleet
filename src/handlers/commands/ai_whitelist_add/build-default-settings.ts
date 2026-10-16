import type { UserApiSettingDefaults } from '../../../persistence/repositories/user-api-setting.repo';

/**
 * Build the default settings stamped onto a brand-new whitelist entry.
 *
 * Konata is an xAI-first chat bot, so a fresh user starts on the xAI
 * provider with web search enabled and a temperature of 1.0; the system
 * prompt is left empty for the user to fill in via `/ai settings`. The
 * concrete xAI model is resolved upstream (cheapest still-listed model)
 * and passed in, keeping this builder pure and trivially testable.
 */
export const buildWhitelistDefaults = (xaiModel: string): UserApiSettingDefaults => ({
  provider: 'xai',
  model: xaiModel,
  temperature: 1.0,
  system_prompt: '',
  web_search: true,
});
