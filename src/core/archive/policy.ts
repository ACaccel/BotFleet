import { z } from 'zod';
import type { ArchiveSnapshot } from './types';
const snowflake = z.string().regex(/^\d+$/);
const rule = z
  .object({
    ruleId: z.string().min(1).max(80),
    sourceId: snowflake,
    action: z.enum(['include', 'exclude']).default('include'),
    guildIds: z.array(snowflake).optional(),
    channelIds: z.array(snowflake).optional(),
    parentIds: z.array(snowflake).optional(),
    applicationIds: z.array(snowflake).optional(),
    messageTypes: z.array(z.number().int().nonnegative()).optional(),
    contains: z.string().min(1).max(256).optional(),
    structures: z
      .array(z.enum(['attachments', 'embeds', 'stickers', 'poll', 'components', 'snapshots']))
      .optional(),
  })
  .strict();
export const ArchivePolicySchema = z
  .object({
    version: z.string().min(1).max(80).default('1'),
    guildIds: z.array(snowflake),
    bots: z.array(rule).default([]),
    webhooks: z.array(rule).default([]),
  })
  .strict()
  .superRefine((policy, context) => {
    const ids = [...policy.bots, ...policy.webhooks].map((entry) => entry.ruleId);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Policy ruleIds must be unique' });
  });
export type ArchivePolicy = z.infer<typeof ArchivePolicySchema>;
interface ArchivePolicyDecision {
  admitted: boolean;
  unresolved: boolean;
  version: string;
  ruleId?: string;
  reason: string;
}
export const evaluatePolicy = (
  snapshot: Partial<ArchiveSnapshot>,
  policy: ArchivePolicy,
): ArchivePolicyDecision => {
  const result = (
    admitted: boolean,
    reason: string,
    ruleId?: string,
    unresolved = false,
  ): ArchivePolicyDecision => ({
    admitted,
    unresolved,
    version: policy.version,
    reason,
    ...(ruleId ? { ruleId } : {}),
  });
  if (!snapshot.guildId || !policy.guildIds.includes(snapshot.guildId))
    return result(false, 'guild-out-of-scope');
  const kind = snapshot.webhookId ? 'webhook' : (snapshot.authorKind ?? 'unknown');
  if (kind === 'human') return result(true, 'human');
  if (kind === 'unknown') return result(true, 'unknown-author-retained', undefined, true);
  const sourceId = kind === 'webhook' ? snapshot.webhookId : snapshot.userId;
  for (const entry of kind === 'webhook' ? policy.webhooks : policy.bots) {
    if (
      entry.sourceId !== sourceId ||
      (entry.guildIds && !entry.guildIds.includes(snapshot.guildId))
    )
      continue;
    if (
      entry.channelIds &&
      !entry.channelIds.includes(snapshot.channelId ?? '') &&
      !entry.channelIds.includes(snapshot.parentId ?? '')
    )
      continue;
    if (entry.parentIds && !entry.parentIds.includes(snapshot.parentId ?? '')) continue;
    if (entry.applicationIds && !entry.applicationIds.includes(snapshot.applicationId ?? ''))
      continue;
    if (entry.messageTypes && !entry.messageTypes.includes(snapshot.type ?? -1)) continue;
    if (entry.contains && !snapshot.content?.includes(entry.contains)) continue;
    if (
      entry.structures &&
      !entry.structures.every((key) => {
        const value = snapshot[key];
        return Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined;
      })
    )
      continue;
    return result(entry.action === 'include', `rule-${entry.action}`, entry.ruleId);
  }
  return result(false, `${kind}-not-allowlisted`);
};
