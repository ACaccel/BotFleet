import { createHash } from 'node:crypto';

import { mongo } from 'mongoose';

import type { RepairDocument } from '../../src/plugins/message-backup/repair/contracts';

export const DATASET_VERSION = 1;
export const SCENARIOS = [
  'clean',
  'bot-heavy',
  'duplicate-conflicts',
  'old-timestamps',
  'reaction-heavy',
  'many-threads',
  'live-updates',
] as const;
export type Scenario = (typeof SCENARIOS)[number];

interface DatasetOptions {
  readonly count: number;
  readonly scenario: Scenario;
}

export interface SyntheticDocument extends RepairDocument {
  readonly _id: string;
}

const EPOCH = 1_700_000_000_000;
const messageId = (index: number): string => String(1_000_000_000_000_000_000n + BigInt(index));

/** Stable IDs and content make identical seeds comparable without reading production data. */
export function syntheticMessage(index: number, scenario: Scenario): SyntheticDocument {
  const duplicate = scenario === 'duplicate-conflicts' && index % 100 === 1;
  const sourceIndex = duplicate ? index - 1 : index;
  const timestamp = EPOCH + sourceIndex;
  return {
    _id: `synthetic-${String(index).padStart(12, '0')}`,
    messageId: messageId(sourceIndex),
    channelId: String(2_000_000_000_000_000_000n + BigInt(index % 100)),
    userId: '3000000000000000000',
    authorKind: scenario === 'bot-heavy' && index % 5 !== 0 ? 'bot' : 'human',
    timestamp: scenario === 'old-timestamps' && index % 10 === 0 ? String(timestamp) : timestamp,
    schemaVersion: 2,
    content: duplicate ? 'Synthetic conflicting snapshot' : 'Synthetic benchmark message',
    attachments: [],
    ...(scenario === 'reaction-heavy'
      ? {
          reactions: Array.from({ length: 5 }, (_, reaction) => ({
            emoji: `synthetic-${reaction}`,
            normal: Array.from({ length: 20 }, (_, user) => String(4_000_000 + user)),
            burst: Array.from({ length: 5 }, (_, user) => String(5_000_000 + user)),
          })),
        }
      : {}),
    ...(scenario === 'many-threads'
      ? { channelId: String(2_000_000_000_000_000_000n + BigInt(index % 10_000)) }
      : {}),
  };
}

/** BSON byte limits apply to the entire staged batch, including the next document. */
export function* syntheticBatches(
  options: DatasetOptions,
  maxDocuments = 500,
  maxBytes = 4 * 1024 * 1024,
): Generator<{ documents: SyntheticDocument[]; bytes: number }> {
  if (!Number.isSafeInteger(options.count) || options.count < 1)
    throw new Error('Dataset count must be a positive safe integer');
  if (
    !Number.isSafeInteger(maxDocuments) ||
    maxDocuments < 1 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1
  )
    throw new Error('Batch limits must be positive');
  let documents: SyntheticDocument[] = [];
  let bytes = 0;
  for (let index = 0; index < options.count; index += 1) {
    const document = syntheticMessage(index, options.scenario);
    const size = mongo.BSON.calculateObjectSize(document);
    if (size > maxBytes) throw new Error('Synthetic document exceeds the batch byte budget');
    if (documents.length >= maxDocuments || bytes + size > maxBytes) {
      yield { documents, bytes };
      documents = [];
      bytes = 0;
    }
    documents.push(document);
    bytes += size;
  }
  if (documents.length > 0) yield { documents, bytes };
}

export function datasetIdentity(options: DatasetOptions): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: DATASET_VERSION,
        count: options.count,
        scenario: options.scenario,
      }),
    )
    .digest('hex');
}
