import type { Connection } from 'mongoose';
import { z } from 'zod';
import { ArchiveContinuityConflictError } from '../../core/archive/errors';
import type { ArchiveGatewayContinuity } from '../../core/archive/types';

type ContinuityDocument = ArchiveGatewayContinuity & { _id: 'current' };

const timestamp = z.number().int().nonnegative();
const continuitySchema = z
  .object({
    bootId: z.string().min(1),
    continuousSince: timestamp,
    confirmedAt: timestamp,
    fullRequired: z.boolean(),
    gapVersion: z.number().int().nonnegative(),
    breakIndex: z.number().int().nonnegative(),
    breaks: z.array(
      z
        .object({
          index: z.number().int().positive(),
          start: timestamp,
          channelId: z.string().min(1).nullable(),
        })
        .strict(),
    ),
  })
  .strict();

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
// Fails to compile when the stored shape and the domain type drift apart.
const schemaMatchesType: Equal<z.infer<typeof continuitySchema>, ArchiveGatewayContinuity> = true;
void schemaMatchesType;

/** Gateway continuity of one guild across worker boots. */
export interface ArchiveContinuityRepo {
  read(): Promise<ArchiveGatewayContinuity | null>;
  begin(continuity: ArchiveGatewayContinuity): Promise<void>;
  write(continuity: ArchiveGatewayContinuity): Promise<void>;
}

/** Per-guild `archive_gateway_continuity` record; only the archive owner writes it. */
export class MongoArchiveContinuityRepo implements ArchiveContinuityRepo {
  public constructor(private readonly connection: Connection) {}

  private collection() {
    return this.connection.collection<ContinuityDocument>('archive_gateway_continuity');
  }

  /** A malformed record proves nothing and reads as absent. */
  public async read(): Promise<ArchiveGatewayContinuity | null> {
    const document = await this.collection().findOne(
      { _id: 'current' },
      { projection: { _id: 0 } },
    );
    const parsed = continuitySchema.safeParse(document);
    return parsed.success ? parsed.data : null;
  }

  /** Claims the record for a new boot; called only after archive ownership is acquired. */
  public async begin(continuity: ArchiveGatewayContinuity): Promise<void> {
    await this.collection().replaceOne({ _id: 'current' }, continuity, { upsert: true });
  }

  /** Writes only while the record still belongs to this boot. */
  public async write(continuity: ArchiveGatewayContinuity): Promise<void> {
    const result = await this.collection().replaceOne(
      { _id: 'current', bootId: continuity.bootId },
      continuity,
    );
    if (result.matchedCount === 0) throw new ArchiveContinuityConflictError(continuity.bootId);
  }
}
