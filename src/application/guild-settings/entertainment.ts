import type { Interaction } from 'discord.js';
import {
  ENTERTAINMENT_COMMANDS,
  type EntertainmentCommand,
  type GuildSettingsRuntime,
} from '../../core/guild-settings';

export type EntertainmentAccess =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'disabled' }
  | { readonly allowed: false; readonly reason: 'cooldown'; readonly seconds: number };

/** Per-member command cooldowns are isolated by application, guild and command. */
export class EntertainmentGate {
  private readonly deadlines = new Map<string, number>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly maximum = 10000,
  ) {}
  check(
    settings: GuildSettingsRuntime,
    guildId: string,
    userId: string,
    command: EntertainmentCommand,
  ): EntertainmentAccess {
    const snapshot = settings.get(guildId);
    const preference = snapshot?.settings.entertainment[command];
    if (!preference?.enabled) return { allowed: false, reason: 'disabled' };
    if (preference.cooldownSeconds === 0) return { allowed: true };
    const now = this.now();
    const key = `${guildId}:${userId}:${command}`;
    const deadline = this.deadlines.get(key) ?? 0;
    if (deadline > now)
      return { allowed: false, reason: 'cooldown', seconds: Math.ceil((deadline - now) / 1000) };
    for (const [existing, expires] of this.deadlines)
      if (expires <= now) this.deadlines.delete(existing);
    if (this.deadlines.size >= this.maximum) {
      // Refuse new reservations until the earliest expires; eviction permits bypasses.
      const earliest = Math.min(...this.deadlines.values());
      return {
        allowed: false,
        reason: 'cooldown',
        seconds: Math.max(1, Math.ceil((earliest - now) / 1000)),
      };
    }
    this.deadlines.set(key, now + preference.cooldownSeconds * 1000);
    return { allowed: true };
  }
}

export const entertainmentCommandFor = (
  interaction: Interaction,
  commandId?: string,
): EntertainmentCommand | undefined => {
  if (!interaction.isChatInputCommand() && !interaction.isContextMenuCommand()) return undefined;
  const name = commandId ?? interaction.commandName;
  return ENTERTAINMENT_COMMANDS.find((command) => command === name);
};
