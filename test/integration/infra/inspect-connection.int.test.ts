/**
 * Integration suite for the `/db` server connection against a real
 * MongoDB: only guild-named (digit-only) databases are listed, a database
 * handle is refused for any other name and never creates a database, and
 * `openInspectConnection` rejects a server that cannot prove the account is
 * read-only (the memory server has no access control).
 */
import mongoose from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigurationError } from '../../../src/core/errors';
import {
  inspectConnectionFor,
  openInspectConnection,
} from '../../../src/infra/mongo/inspect-connection';
import { uniqueGuildId } from '../helpers/mongo';

const serverUri = (): string => {
  const uri = process.env.INTEGRATION_MONGO_URI;
  if (uri === undefined || uri.length === 0) throw new Error('INTEGRATION_MONGO_URI is not set');
  return uri;
};

describe('inspect connection', () => {
  const clients: mongoose.mongo.MongoClient[] = [];
  const databases: string[] = [];

  const connect = async () => {
    const client = new mongoose.mongo.MongoClient(serverUri());
    await client.connect();
    clients.push(client);
    return client;
  };

  afterEach(async () => {
    const [client] = clients;
    if (client !== undefined) {
      for (const name of databases) await client.db(name).dropDatabase();
    }
    databases.length = 0;
    await Promise.all(clients.splice(0).map((open) => open.close()));
  });

  it('lists only digit-named databases, with their size', async () => {
    const client = await connect();
    const guildId = uniqueGuildId();
    const otherName = `it_inspect_${guildId}`;
    databases.push(guildId, otherName);
    await client.db(guildId).collection('items').insertOne({ a: 1 });
    await client.db(otherName).collection('items').insertOne({ a: 1 });

    const listed = await inspectConnectionFor(client).listGuildDatabases();

    const guild = listed.find((entry) => entry.name === guildId);
    expect(guild).toBeDefined();
    expect(typeof guild?.sizeOnDisk).toBe('number');
    expect(listed.map((entry) => entry.name)).not.toContain(otherName);
    for (const entry of listed) expect(entry.name).toMatch(/^\d+$/);
  });

  it('refuses a database handle for a name that is not a guild ID', async () => {
    const connection = inspectConnectionFor(await connect());
    for (const name of ['abc', 'admin', '123abc', '', '12 3', '../1']) {
      expect(() => connection.database(name), name).toThrow(TypeError);
    }
  });

  it('hands out a database handle without creating the database', async () => {
    const client = await connect();
    const connection = inspectConnectionFor(client);
    const guildId = uniqueGuildId();
    databases.push(guildId);

    const db = connection.database(guildId);
    expect(db.databaseName).toBe(guildId);
    expect(await db.collection('items').countDocuments()).toBe(0);

    const listed = await connection.listGuildDatabases();
    expect(listed.map((entry) => entry.name)).not.toContain(guildId);
  });

  it('reads the documents of a guild database', async () => {
    const client = await connect();
    const guildId = uniqueGuildId();
    databases.push(guildId);
    await client
      .db(guildId)
      .collection('items')
      .insertOne({ _id: 'k' as never, v: 7 });

    const found = await inspectConnectionFor(client)
      .database(guildId)
      .collection('items')
      .findOne();
    expect(found).toMatchObject({ _id: 'k', v: 7 });
  });

  it('closes the underlying client', async () => {
    const client = new mongoose.mongo.MongoClient(serverUri());
    await client.connect();
    const connection = inspectConnectionFor(client);
    const close = vi.spyOn(client, 'close');

    await connection.close();

    expect(close).toHaveBeenCalledTimes(1);
    await expect(client.db('admin').command({ ping: 1 })).rejects.toThrow();
  });

  it('rejects a server whose account cannot be proven read-only', async () => {
    await expect(openInspectConnection(serverUri())).rejects.toBeInstanceOf(ConfigurationError);
    await expect(openInspectConnection(serverUri())).rejects.toMatchObject({
      messageKey: 'errors:bot.inspect_account_invalid',
    });
  });
});
