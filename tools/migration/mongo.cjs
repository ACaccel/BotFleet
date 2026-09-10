// This file runs in mongosh before the application dependencies are installed.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- mongosh file execution requires CommonJS.
const fs = require('node:fs');

const SYSTEM_DATABASES = new Set(['admin', 'config', 'local']);

function validateDatabases(databases) {
  if (
    !Array.isArray(databases) ||
    databases.length === 0 ||
    databases.some(
      (name) =>
        typeof name !== 'string' ||
        !/^[A-Za-z0-9_-]+$/.test(name) ||
        Buffer.byteLength(name) > 63 ||
        SYSTEM_DATABASES.has(name),
    ) ||
    new Set(databases).size !== databases.length
  ) {
    throw new Error('Invalid database allowlist');
  }
  return [...databases].sort();
}

function canonical(value, preserveOrder = false) {
  if (Array.isArray(value)) {
    const result = [];
    for (const item of value) result.push(canonical(item, preserveOrder));
    return result;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!preserveOrder) keys.sort();
    const entries = [];
    for (const key of keys) {
      entries.push([key, canonical(value[key], preserveOrder || key === 'key')]);
    }
    return Object.fromEntries(entries);
  }
  return value;
}

function normalizeInventory(inventory) {
  if (!inventory || typeof inventory.version !== 'string') {
    throw new Error('Invalid inventory');
  }
  validateDatabases(inventory.databases?.map((database) => database.name));
  const databases = [];
  for (const database of inventory.databases) {
    const collections = [];
    for (const collection of database.collections) {
      const result = {
        name: collection.name,
        type: collection.type,
        // View pipelines and embedded query values can depend on BSON field order.
        options: canonical(collection.options || {}, true),
      };
      if (collection.type !== 'view') {
        result.count = collection.count;
        result.indexes = [];
        for (const index of collection.indexes) {
          // Server-generated namespace and index format version can differ after restore.
          const { ns: _namespace, v: _version, ...definition } = index;
          result.indexes.push(canonical(definition));
        }
        result.indexes.sort((left, right) =>
          left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
        );
      }
      collections.push(result);
    }
    collections.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    databases.push({ name: database.name, collections });
  }
  databases.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return { version: inventory.version, databases };
}

function compareInventories(expected, actual) {
  const left = normalizeInventory(expected);
  const right = normalizeInventory(actual);
  if (left.version.split('.')[0] !== right.version.split('.')[0]) return 'version';
  if (JSON.stringify(left.databases) !== JSON.stringify(right.databases))
    return 'database inventory';
  return null;
}

function readPrivateRequest(filename) {
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    ) {
      throw new Error('Request permissions are not private');
    }
    return JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeResult(filename, result) {
  const descriptor = fs.openSync(filename, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(result, null, 2)}\n`);
  } finally {
    fs.closeSync(descriptor);
  }
}

async function readInventory(connection, databases, EJSON) {
  const available = await connection
    .getSiblingDB('admin')
    .runCommand({ listDatabases: 1, nameOnly: true });
  if (!available.ok) throw new Error('Database listing failed');
  const names = new Set(available.databases.map((database) => database.name));
  if (databases.some((name) => !names.has(name))) throw new Error('Database missing');
  const inventory = { version: await connection.version(), databases: [] };
  // mongosh awaits database calls, but Array.map would retain async callback promises.
  for (const name of databases) {
    const database = connection.getSiblingDB(name);
    const collections = [];
    for (const info of await database.getCollectionInfos()) {
      // Views are inventoried by definition; MongoDB rebuilds system.views on restore.
      if (info.name === 'system.views') continue;
      if (info.type !== 'collection' && info.type !== 'view') {
        throw new Error('Unsupported collection type');
      }
      const metadata = {
        name: info.name,
        type: info.type,
        options: JSON.parse(EJSON.stringify(info.options, { relaxed: false })),
      };
      if (info.type !== 'view') {
        const collection = database.getCollection(info.name);
        metadata.indexes = JSON.parse(
          EJSON.stringify(await collection.getIndexes(), { relaxed: false }),
        );
        metadata.count = await collection.countDocuments({});
      }
      collections.push(metadata);
    }
    inventory.databases.push({ name, collections });
  }

  // Extended JSON retains BSON-valued collection and index options in the manifest.
  return normalizeInventory(inventory);
}

async function main({ connect, EJSON }) {
  let stage = 'request';
  try {
    const request = readPrivateRequest(process.env.BOTFLEET_MIGRATION_REQUEST);
    let databases = request.action === 'discover' ? [] : validateDatabases(request.databases);
    if (
      !['discover', 'inventory', 'empty', 'create-user', 'verify', 'ping'].includes(request.action)
    ) {
      throw new Error('Unknown action');
    }
    if (typeof request.uri !== 'string' || !request.uri.startsWith('mongodb://')) {
      throw new Error('Invalid URI');
    }
    stage = request.action;
    const connection = await connect(request.uri);
    const admin = connection.getSiblingDB('admin');
    const hello = await admin.runCommand({ hello: 1 });
    if (!hello.ok || hello.setName || hello.msg === 'isdbgrid') {
      throw new Error('Standalone server required');
    }
    if (request.action === 'discover') {
      const available = await admin.runCommand({
        listDatabases: 1,
        nameOnly: true,
        authorizedDatabases: false,
      });
      if (!available.ok) throw new Error('Cannot enumerate every application database');
      databases = validateDatabases(
        available.databases
          .map((database) => database.name)
          .filter((name) => !SYSTEM_DATABASES.has(name)),
      );
    }
    if (request.action === 'ping') {
      const status = await admin.runCommand({ connectionStatus: 1 });
      if (!status.ok || !status.authInfo.authenticatedUsers.length) {
        throw new Error('Authentication required');
      }
    } else if (request.action === 'empty') {
      const result = await admin.runCommand({ listDatabases: 1, nameOnly: true });
      if (!result.ok || result.databases.some((database) => !SYSTEM_DATABASES.has(database.name))) {
        throw new Error('Target is not empty');
      }
    } else if (request.action === 'create-user') {
      if (
        typeof request.user !== 'string' ||
        !request.user ||
        typeof request.password !== 'string' ||
        !request.password ||
        request.authDatabase !== 'admin'
      ) {
        throw new Error('Invalid user settings');
      }
      const auth = connection.getSiblingDB(request.authDatabase);
      // Under the localhost exception, createUser itself rejects an existing user.
      // A usersInfo preflight is unauthorized until the first user is created.
      await auth.createUser({
        user: request.user,
        pwd: request.password,
        roles: [
          // New Discord guilds create databases after migration.
          { role: 'readWriteAnyDatabase', db: 'admin' },
          { role: 'dbAdminAnyDatabase', db: 'admin' },
          { role: 'clusterMonitor', db: 'admin' },
        ],
      });
    } else if (request.action !== 'ping') {
      const inventory = await readInventory(connection, databases, EJSON);
      if (request.action === 'inventory' || request.action === 'discover') {
        writeResult(request.output, inventory);
      } else {
        const expected = JSON.parse(fs.readFileSync(request.expected, 'utf8'));
        if (compareInventories(expected, inventory)) throw new Error('Inventory mismatch');
      }
    }
    process.stdout.write(`${JSON.stringify({ status: 'ok', action: request.action })}\n`);
  } catch {
    // Driver exceptions may embed credentials or document contents.
    process.stderr.write(`MongoDB migration ${stage} failed.\n`);
    throw new Error('MongoDB operation failed.');
  }
}

module.exports = {
  validateDatabases,
  normalizeInventory,
  compareInventories,
  readPrivateRequest,
  main,
};
