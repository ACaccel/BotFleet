import type { BoundTranslate } from '../core/i18n';

/** Keep stored target IDs copyable while distinguishing forum subscription scopes. */
export const formatFeedTarget = (platform: string, account: string, t?: BoundTranslate): string => {
  if (platform === 'youtube') return account;
  if (platform !== 'bahamut') return `@${account}`;
  if (t === undefined) return account;
  if (/^board:\d+(?::\d+)?$/.test(account)) return t('replies:feed.target_board', { account });
  if (/^\d+\/\d+$/.test(account)) return t('replies:feed.target_thread', { account });
  return account;
};
