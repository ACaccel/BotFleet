import { createHash } from 'node:crypto';
import { mongo } from 'mongoose';

export const cloneRepairDocument = <T extends Record<string, unknown>>(document: T): T =>
  mongo.BSON.deserialize(mongo.BSON.serialize(document)) as T;

/** BSON preserves native identity and timestamp types in recovery images. */
export const repairHash = (document: Record<string, unknown> | null): string =>
  createHash('sha256')
    .update(document === null ? 'null' : mongo.BSON.serialize(document))
    .digest('hex');
