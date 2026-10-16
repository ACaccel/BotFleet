import { z } from 'zod';
import { archiveAuthorKind } from './normalize';
import type { ArchiveExcludableField, ArchiveSnapshot, Equal } from './types';
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
type ArchivePolicyRule = ArchivePolicy['bots'][number];

/** Where a message was posted; the guild and parent come from the event or `archive_channels`. */
export interface ArchivePolicyLocation {
  readonly guildId: string;
  readonly parentId?: string;
}
/**
 * The admission of one message, discriminated on `reason`: `human` and
 * `rule-include` keep the whole message, `interaction-record` only its interaction
 * record, `unknown-author-retained` only its identity until the author is known.
 */
export type ArchivePolicyDecision = { readonly version: string } & (
  | {
      readonly admitted: true;
      readonly reason: 'human' | 'unknown-author-retained' | 'interaction-record';
    }
  | { readonly admitted: true; readonly reason: 'rule-include'; readonly ruleId: string }
  | {
      readonly admitted: false;
      readonly reason: 'guild-out-of-scope' | 'bot-not-allowlisted' | 'webhook-not-allowlisted';
    }
  | { readonly admitted: false; readonly reason: 'rule-exclude'; readonly ruleId: string }
);
export type ArchiveAdmission = Extract<ArchivePolicyDecision, { admitted: true }>;

/** Fields an interaction record keeps; `/traffic apps` counts command use from them. */
type InteractionRecordField =
  | '_id'
  | 'schemaVersion'
  | 'channelId'
  | 'author'
  | 'applicationId'
  | 'interactionMetadata'
  | 'type'
  | 'createdTimestamp'
  | 'observedAt';
/** Observed fields an interaction record deliberately drops, listed in `excludedFields`. */
export const INTERACTION_RECORD_EXCLUDED_FIELDS = [
  'webhookId',
  'flags',
  'content',
  'editedTimestamp',
  'attachments',
  'stickers',
  'embeds',
  'components',
  'reactions',
  'mentions',
  'reference',
  'thread',
  'poll',
  'messageSnapshots',
] as const satisfies readonly ArchiveExcludableField[];
// Every snapshot field is either kept by an interaction record, excluded from it, or policy metadata.
const interactionRecordCovered: Equal<
  | InteractionRecordField
  | (typeof INTERACTION_RECORD_EXCLUDED_FIELDS)[number]
  | 'excludedFields'
  | 'policy',
  keyof ArchiveSnapshot
> = true;
void interactionRecordCovered;
const STRUCTURE_FIELDS = {
  attachments: 'attachments',
  embeds: 'embeds',
  stickers: 'stickers',
  poll: 'poll',
  components: 'components',
  snapshots: 'messageSnapshots',
} as const satisfies Record<
  NonNullable<ArchivePolicyRule['structures']>[number],
  keyof ArchiveSnapshot
>;

const matches = (
  entry: ArchivePolicyRule,
  sourceId: string | undefined,
  snapshot: Partial<ArchiveSnapshot>,
  location: ArchivePolicyLocation,
): boolean => {
  if (entry.sourceId !== sourceId) return false;
  if (entry.guildIds && !entry.guildIds.includes(location.guildId)) return false;
  if (
    entry.channelIds &&
    !entry.channelIds.includes(snapshot.channelId ?? '') &&
    !entry.channelIds.includes(location.parentId ?? '')
  )
    return false;
  if (entry.parentIds && !entry.parentIds.includes(location.parentId ?? '')) return false;
  if (entry.applicationIds && !entry.applicationIds.includes(snapshot.applicationId ?? ''))
    return false;
  if (entry.messageTypes && !entry.messageTypes.includes(snapshot.type ?? -1)) return false;
  if (entry.contains && !snapshot.content?.includes(entry.contains)) return false;
  return (
    !entry.structures ||
    entry.structures.every((key) => {
      const value = snapshot[STRUCTURE_FIELDS[key]];
      return Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined;
    })
  );
};

/** A bot reply to an interaction; it may arrive through the application's webhook. */
const isInteractionReply = (snapshot: Partial<ArchiveSnapshot>): boolean =>
  snapshot.interactionMetadata !== undefined && snapshot.author?.bot === true;

/** The rule lists and source IDs a bot or webhook message is matched against, in order. */
const ruleSources = (
  snapshot: Partial<ArchiveSnapshot>,
  policy: ArchivePolicy,
  kind: 'bot' | 'webhook',
): readonly (readonly [readonly ArchivePolicyRule[], string | undefined])[] =>
  kind === 'webhook'
    ? [
        [policy.webhooks, snapshot.webhookId],
        ...(isInteractionReply(snapshot) ? [[policy.bots, snapshot.author?.id] as const] : []),
      ]
    : [[policy.bots, snapshot.author?.id]];

/**
 * Human messages are kept. Bot and webhook messages are kept only by a matching
 * `include` rule; the first matching rule decides. A bot reply to an interaction
 * that no rule matches keeps only its interaction record. An interaction reply
 * delivered through the application's webhook is also matched against the bot
 * rules of its author, so a bot `exclude` rule drops its interaction records too.
 * Decisions apply to new observations only; stored messages are never removed.
 */
export const evaluatePolicy = (
  snapshot: Partial<ArchiveSnapshot>,
  policy: ArchivePolicy,
  location: ArchivePolicyLocation,
): ArchivePolicyDecision => {
  const version = policy.version;
  if (!policy.guildIds.includes(location.guildId))
    return { version, admitted: false, reason: 'guild-out-of-scope' };
  const kind = archiveAuthorKind(snapshot);
  if (kind === 'human') return { version, admitted: true, reason: 'human' };
  if (kind === 'unknown') return { version, admitted: true, reason: 'unknown-author-retained' };
  for (const [rules, sourceId] of ruleSources(snapshot, policy, kind))
    for (const entry of rules)
      if (matches(entry, sourceId, snapshot, location))
        return entry.action === 'include'
          ? { version, admitted: true, reason: 'rule-include', ruleId: entry.ruleId }
          : { version, admitted: false, reason: 'rule-exclude', ruleId: entry.ruleId };
  if (isInteractionReply(snapshot))
    return { version, admitted: true, reason: 'interaction-record' };
  return {
    version,
    admitted: false,
    reason: kind === 'bot' ? 'bot-not-allowlisted' : 'webhook-not-allowlisted',
  };
};

/**
 * Whether no rule names the source, so no rule could keep its full message and its
 * content need not be captured. Mirrors the rule lookup of {@link evaluatePolicy}.
 */
export const policyIgnoresContent = (
  snapshot: Partial<ArchiveSnapshot>,
  policy: ArchivePolicy,
): boolean => {
  const kind = archiveAuthorKind(snapshot);
  switch (kind) {
    case 'webhook':
    case 'bot':
      return ruleSources(snapshot, policy, kind).every(
        ([rules, sourceId]) => !rules.some((entry) => entry.sourceId === sourceId),
      );
    case 'human':
    case 'unknown':
      return false;
    default: {
      const unreachable: never = kind;
      throw new TypeError(`Unknown archive author kind ${String(unreachable)}`);
    }
  }
};

/**
 * The observation to store for an admitted message. Human messages carry no
 * policy record; an interaction record keeps only its identifying fields, and a
 * message whose author is unknown only its identity until a later observation
 * classifies it.
 */
export const applyPolicyDecision = (
  snapshot: ArchiveSnapshot,
  decision: ArchiveAdmission,
): ArchiveSnapshot => {
  const { policy: _previous, excludedFields: _excluded, ...message } = snapshot;
  const identity: ArchiveSnapshot = {
    _id: snapshot._id,
    schemaVersion: snapshot.schemaVersion,
    channelId: snapshot.channelId,
    createdTimestamp: snapshot.createdTimestamp,
    observedAt: snapshot.observedAt,
  };
  switch (decision.reason) {
    case 'human':
      return message;
    case 'rule-include':
      return {
        ...message,
        policy: { version: decision.version, reason: decision.reason, ruleId: decision.ruleId },
      };
    case 'unknown-author-retained':
      return { ...identity, policy: { version: decision.version, reason: decision.reason } };
    case 'interaction-record':
      return {
        ...identity,
        ...(snapshot.author === undefined ? {} : { author: snapshot.author }),
        ...(snapshot.applicationId === undefined ? {} : { applicationId: snapshot.applicationId }),
        ...(snapshot.interactionMetadata === undefined
          ? {}
          : { interactionMetadata: snapshot.interactionMetadata }),
        ...(snapshot.type === undefined ? {} : { type: snapshot.type }),
        excludedFields: [...INTERACTION_RECORD_EXCLUDED_FIELDS],
        policy: { version: decision.version, reason: decision.reason },
      };
    default: {
      const unreachable: never = decision;
      throw new TypeError(`Unknown archive admission ${JSON.stringify(unreachable)}`);
    }
  }
};
