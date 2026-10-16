import { Schema, type InferSchemaType, type Types } from 'mongoose';

/**
 * Temporary notification-role state.
 *
 * One document per role created via `/role temp create`. The Discord role
 * carries no permissions and exists only so members can self-claim it
 * (to be `@mentioned`) until `expires_at`, at which point a scheduled
 * job deletes the role, edits the claim message, and removes this
 * document. Documents are keyed by the Discord `role_id`; the unique
 * index both enforces that and gives the boot-time reboot sweep a cheap
 * lookup path.
 */
export const tempRoleSchema = new Schema({
  role_id: { type: String, required: true, unique: true },
  channel_id: { type: String, required: true },
  message_id: { type: String, required: true },
  creator_id: { type: String, required: true },
  role_name: { type: String, required: true },
  expires_at: { type: Number, required: true },
});

export type TempRoleDoc = InferSchemaType<typeof tempRoleSchema> & {
  readonly _id: Types.ObjectId;
};
