/**
 * Discord message archived by the msg-archive bot (schema version 3).
 *
 * Field names follow discord.js. An absent field was not observed; an empty
 * array or `null` is authoritative emptiness. The archive worker writes raw
 * documents shaped by `core/archive/normalize`; this schema describes them for
 * readers and is checked against the normalizer by the contract tests. The full
 * field reference is `docs/message-archive.md`.
 */
import { Schema, type InferSchemaType } from 'mongoose';
import {
  ARCHIVE_SCHEMA_VERSION,
  type ArchiveMessage,
  type Equal,
  type RequiredKeys,
} from '../../core/archive/types';

// Arrays default to absent rather than `[]`, so "not observed" stays distinguishable.
const optionalArray = <T>(item: T) => ({ type: [item], default: undefined });
const sub = <T extends object>(fields: T) => new Schema(fields, { _id: false });

const emojiSchema = sub({ id: String, name: String, animated: Boolean });
const userSchema = sub({
  id: { type: String, required: true },
  username: String,
  globalName: String,
  bot: Boolean,
});
const attachmentSchema = sub({
  id: String,
  name: String,
  title: String,
  description: String,
  contentType: String,
  size: Number,
  width: Number,
  height: Number,
  duration: Number,
  flags: Number,
  url: String,
});
const stickerSchema = sub({ id: String, name: String, format: Number });
const embedMediaSchema = sub({ url: String, width: Number, height: Number });
const embedSchema = sub({
  type: String,
  title: String,
  description: String,
  url: String,
  color: Number,
  timestamp: Number,
  author: sub({ name: String, url: String }),
  footer: sub({ text: String }),
  provider: sub({ name: String, url: String }),
  image: embedMediaSchema,
  thumbnail: embedMediaSchema,
  video: embedMediaSchema,
  fields: optionalArray(sub({ name: String, value: String, inline: Boolean })),
});
const reactionSchema = sub({
  emoji: { type: emojiSchema, required: true },
  count: Number,
  countDetails: sub({ normal: Number, burst: Number }),
});
const pollSchema = sub({
  question: sub({ text: String }),
  answers: optionalArray(sub({ id: Number, text: String, emoji: emojiSchema, voteCount: Number })),
  expiresTimestamp: Number,
  allowMultiselect: Boolean,
  resultsFinalized: Boolean,
});
const interactionMetadataSchema = sub({
  id: String,
  type: Number,
  user: userSchema,
  targetUserId: String,
  targetMessageId: String,
  interactedMessageId: String,
});
const messageSnapshotSchema = sub({
  type: Number,
  flags: Number,
  content: String,
  createdTimestamp: Number,
  editedTimestamp: Number,
  attachments: optionalArray(attachmentSchema),
  stickers: optionalArray(stickerSchema),
  embeds: optionalArray(embedSchema),
  // Discord component trees are recursive (normalized to depth 8), so a fixed schema cannot describe them.
  components: optionalArray(Schema.Types.Mixed),
});
const editSchema = sub({
  editedTimestamp: Number,
  observedAt: { type: Number, required: true },
  content: String,
  attachments: optionalArray(attachmentSchema),
  embeds: optionalArray(embedSchema),
  // Recursive component trees; see `components` on the message.
  components: optionalArray(Schema.Types.Mixed),
});

export const messageSchema = new Schema(
  {
    // The Discord message snowflake is the natural key; it replaces both ObjectId and a separate unique index.
    _id: { type: String, required: true },
    schemaVersion: { type: Number, required: true, enum: [ARCHIVE_SCHEMA_VERSION] },
    channelId: { type: String, required: true },

    author: userSchema,
    webhookId: String,
    applicationId: String,
    interactionMetadata: interactionMetadataSchema,

    type: Number,
    flags: Number,
    content: String,
    createdTimestamp: { type: Number, required: true },
    editedTimestamp: { type: Number, default: undefined },

    attachments: optionalArray(attachmentSchema),
    stickers: optionalArray(stickerSchema),
    embeds: optionalArray(embedSchema),
    // Discord component trees are recursive (normalized to depth 8), so a fixed schema cannot describe them.
    components: optionalArray(Schema.Types.Mixed),
    reactions: optionalArray(reactionSchema),
    mentions: sub({
      users: optionalArray(String),
      roles: optionalArray(String),
      channels: optionalArray(String),
      everyone: Boolean,
    }),
    reference: sub({
      guildId: String,
      channelId: String,
      messageId: String,
      type: Number,
      authorId: String,
    }),
    thread: sub({ id: String, name: String, type: Number }),
    poll: { type: pollSchema, default: undefined },
    messageSnapshots: optionalArray(messageSnapshotSchema),

    editHistory: optionalArray(editSchema),
    editHistoryDropped: Number,
    excludedFields: optionalArray(String),

    observedAt: { type: Number, required: true },
    reactionGenerations: {
      type: Map,
      of: sub({ generation: String, observedAt: Number, complete: Boolean }),
      default: undefined,
    },
    reactionsFreshAt: Number,
    reactionsStaleAt: Number,
    deletedAt: Number,
    policy: sub({ version: { type: String, required: true }, ruleId: String, reason: String }),
  },
  { collection: 'messages', minimize: false },
);

// `{ createdTimestamp: 1 }` serves cross-channel time-range statistics; the compound
// index serves per-channel range reads and their `createdTimestamp` sort.
messageSchema.index({ createdTimestamp: 1 });
messageSchema.index({ channelId: 1, createdTimestamp: 1 });

/**
 * A stored message as readers receive it from a lean query: the plain document the
 * archive writes, so readers and the writer share one contract.
 */
export type MessageDoc = ArchiveMessage;

// The schema must declare exactly the document's fields and require the same ones.
type InferredMessage = InferSchemaType<typeof messageSchema>;
const schemaFieldsMatch: Equal<keyof InferredMessage, keyof ArchiveMessage> = true;
const schemaRequiredFieldsMatch: Equal<
  RequiredKeys<InferredMessage>,
  RequiredKeys<ArchiveMessage>
> = true;
void schemaFieldsMatch;
void schemaRequiredFieldsMatch;
