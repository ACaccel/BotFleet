import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { DiscordAPIError, RESTJSONErrorCodes, type GuildMember } from 'discord.js';

import identityConfig from './identity.json';

/**
 * Persona images live outside version control under the shared `data/`
 * directory, so the bot neither depends on a third-party image host nor
 * publishes artwork with the source.
 */
const AVATAR_DIR = './data/avatars';

export type Persona = (typeof identityConfig)[number];

export const PERSONAS: readonly Persona[] = identityConfig;

export const findPersona = (name: string): Persona | undefined =>
  PERSONAS.find((persona) => persona.name === name);

/** The persona's avatar bytes, or `null` when the operator has not installed the file. */
export const readPersonaAvatar = async (persona: Persona): Promise<Buffer | null> => {
  try {
    return await readFile(path.join(AVATAR_DIR, path.basename(persona.avatar_file)));
  } catch {
    return null;
  }
};

/** Discord limits how often a bot account may change its avatar. */
export const isAvatarRateLimit = (error: unknown): boolean =>
  error instanceof DiscordAPIError &&
  (error.status === 429 || error.code === RESTJSONErrorCodes.InvalidFormBodyOrContentType);

/**
 * Swap the bot's persona colour role: drop every other persona colour
 * role it holds, so unrelated colour roles stay, then add the new one.
 */
export const swapColorRole = async (me: GuildMember, persona: Persona): Promise<void> => {
  const personaColors = new Set(PERSONAS.map((entry) => entry.color_role));
  const stale = me.roles.cache.filter(
    (role) => personaColors.has(role.name) && role.name !== persona.color_role,
  );
  if (stale.size > 0) await me.roles.remove([...stale.keys()]);
  const next = me.guild.roles.cache.find((role) => role.name === persona.color_role);
  if (next !== undefined && !me.roles.cache.has(next.id)) await me.roles.add(next);
};
