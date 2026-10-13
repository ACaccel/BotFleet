/**
 * Optional `temp_role` block of a bot's `config.json`.
 *
 * `maxActivePerMember` bounds how many temp roles one member may have
 * active at once, so open creation cannot fill the guild's role list.
 */
import { z } from 'zod';

const DEFAULT_MAX_ACTIVE_PER_MEMBER = 3;

const ConfigSchema = z
  .object({
    temp_role: z
      .object({ maxActivePerMember: z.number().int().min(1).max(50) })
      .strict()
      .optional(),
  })
  .passthrough();

/** The per-member cap; throws on a malformed block so startup reports it. */
export const parseTempRoleConfig = (botConfig: unknown): { maxActivePerMember: number } => ({
  maxActivePerMember:
    ConfigSchema.parse(botConfig ?? {}).temp_role?.maxActivePerMember ??
    DEFAULT_MAX_ACTIVE_PER_MEMBER,
});
