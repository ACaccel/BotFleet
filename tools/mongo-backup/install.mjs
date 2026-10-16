// Renders and installs the systemd service and timer for the daily MongoDB backup.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SERVICE = 'pleiades-mongo-backup.service';
export const TIMER = 'pleiades-mongo-backup.timer';
const UNIT_DIR = '/etc/systemd/system';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const usage =
  'Usage: install.mjs install [--dir /absolute/dir] [--keep N] | uninstall | render OUTPUT_DIR [--dir ...] [--keep N]';

/** @typedef {{root:string,user:string,node:string,mongoPrefix:string,envFile:string,backupDir:string,keep:number}} Settings */

/** @param {string} root @returns {string} */
export const ownerMarker = (root) => `# Managed by Pleiades: ${root}\n`;

/** @param {unknown} value @param {string} field @returns {string} */
function absolute(value, field) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\r\n\0]/.test(value))
    throw new Error(`deployment.json ${field} must be an absolute path.`);
  return value;
}

/** @param {string} value @returns {string} */
function backupDirectory(value) {
  // ReadWritePaths= has its own quoting rules; plain path characters avoid escaping entirely.
  if (!/^\/[A-Za-z0-9._/-]+$/.test(value) || value.split('/').includes('..'))
    throw new Error('--dir must be an absolute path of letters, digits, ".", "_", "-" and "/".');
  return value;
}

/** @param {string} root @param {{backupDir?:string,keep?:string}} [overrides] @returns {Promise<Settings>} */
export async function readSettings(root, overrides = {}) {
  let config;
  try {
    config = JSON.parse(await fs.readFile(path.join(root, 'deployment.json'), 'utf8'));
  } catch {
    throw new Error('Configure deployment.json before installing the backup timer.');
  }
  if (
    typeof config.user !== 'string' ||
    !/^[a-z_][a-z0-9_-]*$/.test(config.user) ||
    config.user === 'root'
  )
    throw new Error('deployment.json user must be an ordinary service user.');
  if (!config.mongodb) throw new Error('deployment.json mongodb is required for backups.');
  const keep = overrides.keep ?? '3';
  if (!/^[1-9]\d*$/.test(keep)) throw new Error('--keep must be a positive integer.');
  const runtime = config.runtimePrefix
    ? absolute(config.runtimePrefix, 'runtimePrefix')
    : path.join(root, '.conda');
  return {
    root,
    user: config.user,
    node: path.join(runtime, 'bin/node'),
    mongoPrefix: absolute(config.mongodb.prefix, 'mongodb.prefix'),
    envFile: absolute(config.mongodb.probeEnvFile, 'mongodb.probeEnvFile'),
    backupDir: backupDirectory(overrides.backupDir ?? '/var/backups/pleiades'),
    keep: Number(keep),
  };
}

/** @param {string} value @returns {string} */
function quote(value) {
  const escaped = value
    .replaceAll('%', '%%')
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('$', '$$$$');
  return `"${escaped}"`;
}

/** @param {Settings} settings @returns {Record<string,string>} */
export function renderUnits(settings) {
  const command = [
    settings.node,
    path.join(settings.root, 'tools/mongo-backup/backup.mjs'),
    '--env-file',
    settings.envFile,
    '--mongo-prefix',
    settings.mongoPrefix,
    '--out-dir',
    settings.backupDir,
    '--keep',
    String(settings.keep),
  ];
  const service = `${ownerMarker(settings.root)}[Unit]
Description=Pleiades MongoDB backup
After=mongodb-pleiades.service

[Service]
Type=oneshot
User=${settings.user}
UMask=0077
ExecStart=${command.map(quote).join(' ')}
TimeoutStartSec=2h
Nice=10
IOSchedulingClass=idle
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${settings.backupDir}
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=true
LockPersonality=true
SystemCallArchitectures=native
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pleiades-mongo-backup
`;
  const timer = `${ownerMarker(settings.root)}[Unit]
Description=Daily Pleiades MongoDB backup

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
`;
  return { [SERVICE]: service, [TIMER]: timer };
}

/** @param {string} program @param {string[]} args @returns {string} */
function run(program, args) {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit'],
  });
  if (result.error || result.status !== 0) throw new Error(`${program} ${args[0] ?? ''} failed.`);
  return result.stdout;
}

/** @param {string} root @param {string} unit @returns {Promise<boolean>} */
async function assertOwned(root, unit) {
  let content;
  try {
    content = await fs.readFile(path.join(UNIT_DIR, unit), 'utf8');
  } catch {
    return false;
  }
  if (!content.startsWith(ownerMarker(root))) throw new Error(`Refusing unmanaged unit: ${unit}`);
  return true;
}

/** @param {Settings} settings @returns {Promise<void>} */
async function install(settings) {
  if (os.userInfo().username !== settings.user)
    throw new Error('Run as the deployment user in deployment.json; system changes use sudo.');
  for (const file of [settings.node, path.join(settings.mongoPrefix, 'bin/mongodump')])
    await fs.access(file, fs.constants.X_OK).catch(() => {
      throw new Error(`Missing executable: ${file}`);
    });
  await fs.access(settings.envFile, fs.constants.R_OK).catch(() => {
    throw new Error(`Cannot read ${settings.envFile}.`);
  });
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiades-backup-units-'));
  try {
    const units = renderUnits(settings);
    for (const [name, content] of Object.entries(units))
      await fs.writeFile(path.join(staging, name), content, { mode: 0o644 });
    run('systemd-analyze', [
      'verify',
      ...Object.keys(units).map((name) => path.join(staging, name)),
    ]);
    for (const name of Object.keys(units)) await assertOwned(settings.root, name);
    const group = run('id', ['-gn', settings.user]).trim();
    run('sudo', [
      'install',
      '-d',
      '-m',
      '0700',
      '-o',
      settings.user,
      '-g',
      group,
      settings.backupDir,
    ]);
    for (const name of Object.keys(units))
      run('sudo', [
        'install',
        '-m',
        '0644',
        '--',
        path.join(staging, name),
        path.join(UNIT_DIR, name),
      ]);
    run('sudo', ['systemctl', 'daemon-reload']);
    run('sudo', ['systemctl', 'enable', '--now', TIMER]);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  process.stdout.write(
    `Installed ${TIMER}; backups go to ${settings.backupDir} (keep ${settings.keep}).\nRun one now: sudo systemctl start ${SERVICE}\n`,
  );
}

/** @param {string} root @returns {Promise<void>} */
async function uninstall(root) {
  const present = [];
  for (const name of [TIMER, SERVICE]) if (await assertOwned(root, name)) present.push(name);
  if (present.length === 0) {
    process.stdout.write('No backup units installed.\n');
    return;
  }
  if (present.includes(TIMER)) run('sudo', ['systemctl', 'disable', '--now', TIMER]);
  run('sudo', ['rm', '-f', '--', ...present.map((name) => path.join(UNIT_DIR, name))]);
  run('sudo', ['systemctl', 'daemon-reload']);
  process.stdout.write('Removed backup units; existing backups were kept.\n');
}

/** @param {string[]} args @returns {{action:string,output?:string,backupDir?:string,keep?:string}} */
export function parseArgs(args) {
  const [action, ...rest] = args;
  if (!['install', 'uninstall', 'render'].includes(action ?? '')) throw new Error(usage);
  /** @type {{action:string,output?:string,backupDir?:string,keep?:string}} */
  const parsed = { action: /** @type {string} */ (action) };
  if (action === 'render') parsed.output = rest.shift();
  if (action === 'render' && (!parsed.output || !path.isAbsolute(parsed.output)))
    throw new Error(usage);
  if (action === 'uninstall' && rest.length > 0) throw new Error(usage);
  for (let index = 0; index < rest.length; index += 2) {
    const value = rest[index + 1];
    if (value === undefined) throw new Error(usage);
    if (rest[index] === '--dir') parsed.backupDir = value;
    else if (rest[index] === '--keep') parsed.keep = value;
    else throw new Error(usage);
  }
  return parsed;
}

async function main() {
  if (process.getuid?.() === 0) throw new Error('Run as the deployment user, not root.');
  const options = parseArgs(process.argv.slice(2));
  if (options.action === 'uninstall') return uninstall(repo);
  const settings = await readSettings(repo, options);
  if (options.action === 'install') return install(settings);
  await fs.mkdir(/** @type {string} */ (options.output), { recursive: true });
  for (const [name, content] of Object.entries(renderUnits(settings)))
    await fs.writeFile(path.join(/** @type {string} */ (options.output), name), content);
  process.stdout.write(`Rendered ${SERVICE} and ${TIMER} into ${options.output}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Install failed.'}\n`);
    process.exitCode = 1;
  });
