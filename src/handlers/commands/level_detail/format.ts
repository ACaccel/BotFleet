import type { Translator } from '../../../core/i18n';
import type { Mee6Player } from '../mee6-shared/leaderboard';

/** Most ranks one reply shows; ten blocks stay well under 2000 characters. */
export const MAX_RANKS = 10;

/** Average XP per message, `0` for a player with no counted messages. */
const averageXp = (player: Mee6Player): string =>
  player.messageCount > 0 ? (player.xp.totalXp / player.messageCount).toPrecision(6) : '0';

/** One block per player: rank, name and level, then message and XP figures. */
export const formatLevelDetails = (
  players: readonly Mee6Player[],
  translator: Translator | undefined,
): string =>
  players
    .map((player) => {
      const t = (key: string, params: Record<string, string | number>): string =>
        translator?.t(`replies:level_detail.${key}`, params) ?? '';
      return [
        `> **${player.rank} - ${player.username}﹝Level ${player.level}﹞**\n`,
        t('message_count', { count: player.messageCount }),
        t('current_xp', { userXp: player.xp.userXp, levelXp: player.xp.levelXp }),
        t('total_xp', { totalXp: player.xp.totalXp }),
        t('average_xp', { averageXp: averageXp(player) }),
      ].join('');
    })
    .join('');
