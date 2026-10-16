import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'dotenv';
import { mongo } from 'mongoose';

export async function waitForMongo(envFile: string, timeoutSeconds: number): Promise<void> {
  const uri = parse(readFileSync(envFile)).MONGO_URI;
  if (!uri || !/^mongodb(?:\+srv)?:\/\//.test(uri))
    throw new Error('A valid MONGO_URI is required in the configured probe env file');
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const budget = Math.max(1, Math.min(2000, deadline - Date.now()));
    const client = new mongo.MongoClient(uri, {
      serverSelectionTimeoutMS: budget,
      connectTimeoutMS: budget,
      socketTimeoutMS: budget,
      timeoutMS: budget,
    });
    try {
      await client.connect();
      await client.db().command({ ping: 1 });
      return;
    } catch {
      // Driver errors may contain credentials or topology addresses.
    } finally {
      await client.close();
    }
    await delay(Math.min(500, Math.max(0, deadline - Date.now())));
  }
  throw new Error(
    'MongoDB did not become ready before the deadline; inspect the service journal and credentials',
  );
}
