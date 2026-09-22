import { join } from 'node:path';
import { ownerMarker, type Release } from './config';

function quote(value: string, command = false): string {
  if (/[\r\n\0]/.test(value)) throw new Error('Invalid systemd value');
  const escaped = value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `"${command ? escaped.replaceAll('$', '$$$$') : escaped}"`;
}
function command(args: readonly string[]): string {
  return args.map((arg, index) => quote(arg, index > 0)).join(' ');
}
function header(release: Release, description: string, after: string): string {
  return `${ownerMarker(release.root)}[Unit]\nDescription=${description}\nAfter=network-online.target ${after}\nWants=network-online.target\nStartLimitIntervalSec=0\n\n[Service]\nType=exec\nUser=${release.config.user}\nWorkingDirectory=${release.directory.replaceAll('%', '%%')}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=60\nKillSignal=SIGTERM\nKillMode=control-group\nNoNewPrivileges=true\nUMask=0077\nStandardOutput=journal\nStandardError=journal\n`;
}
const install = '\n[Install]\nWantedBy=multi-user.target\n';
export function botUnit(release: Release, bot: string, needsDatabase: boolean): string {
  const node = join(release.prefix, 'bin/node');
  const args = [node, '-r', 'ts-node/register', '-r', 'tsconfig-paths/register'];
  const runtime = `botfleet-${bot}`;
  let body = header(
    release,
    `BotFleet ${bot}`,
    needsDatabase && release.config.mongodb ? 'mongodb-botfleet.service' : '',
  );
  if (needsDatabase && release.config.mongodb)
    body = body.replace(
      'Wants=network-online.target',
      'Wants=network-online.target mongodb-botfleet.service',
    );
  body += `Environment=${quote(`PATH=${release.prefix}/bin:${release.directory}/node_modules/.bin:/usr/bin:/bin`)}\nEnvironment=${quote(`CONDA_PREFIX=${release.prefix}`)}\nEnvironment=NODE_ENV=production\nEnvironment=${quote(`TS_NODE_PROJECT=${release.directory}/tsconfig.json`)}\nEnvironment=${quote(`BOTFLEET_READY_FILE=/run/${runtime}/ready.json`)}\nRuntimeDirectory=${runtime}\nRuntimeDirectoryMode=0700\nTimeoutStartSec=${release.config.readinessTimeoutSeconds + 15}\n`;
  if (needsDatabase)
    body += `ExecStartPre=${command([...args, join(release.directory, 'scripts/mongo-ready.ts'), join(release.directory, 'src/bot', bot, '.env'), String(release.config.readinessTimeoutSeconds)])}\n`;
  body += `ExecStart=${command([...args, join(release.directory, 'src/bot', bot, 'index.ts')])}\n`;
  return body + install;
}
export function mongoUnit(release: Release, configFile: string): string {
  const mongo = release.config.mongodb;
  if (!mongo) throw new Error('mongodb configuration is required');
  return (
    header(release, 'BotFleet MongoDB', '') +
    `Environment=${quote(`PATH=${mongo.prefix}/bin:/usr/bin:/bin`)}\nEnvironment=${quote(`CONDA_PREFIX=${mongo.prefix}`)}\nTimeoutStartSec=${release.config.readinessTimeoutSeconds + 15}\nLimitNOFILE=64000\nExecStart=${command([join(mongo.prefix, 'bin/mongod'), '--config', configFile])}\n` +
    install
  );
}
