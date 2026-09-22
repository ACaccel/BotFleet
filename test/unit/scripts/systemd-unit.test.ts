import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deploymentSchema, type Release } from '../../../scripts/deployment/config';
import { botUnit, mongoUnit } from '../../../scripts/deployment/units';

// Deployment targets Linux hosts with systemd; verification never installs or starts these units.
describe('systemd static verification', () => {
  it('accepts bot and database units with spaces, percent and dollar characters in paths', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'botfleet-systemd-'));
    try {
      const root = join(temporary, 'project space % literal $HOME');
      const directory = join(root, '.deploy/releases/example');
      const prefix = join(root, '.conda');
      const mongoPrefix = join(root, 'mongo runtime');
      mkdirSync(directory, { recursive: true });
      mkdirSync(join(prefix, 'bin'), { recursive: true });
      mkdirSync(join(mongoPrefix, 'bin'), { recursive: true });
      symlinkSync(process.execPath, join(prefix, 'bin/node'));
      symlinkSync(process.execPath, join(mongoPrefix, 'bin/mongod'));
      const release: Release = {
        root,
        directory,
        prefix,
        config: deploymentSchema.parse({
          user: userInfo().username === 'root' ? 'nobody' : userInfo().username,
          bots: ['nijika'],
          mongodb: {
            prefix: mongoPrefix,
            configFile: join(root, 'mongod.conf'),
            probeEnvFile: join(root, 'probe.env'),
          },
        }),
        units: {},
      };
      const bot = join(directory, 'botfleet@nijika.service');
      const database = join(directory, 'mongodb-botfleet.service');
      writeFileSync(bot, botUnit(release, 'nijika', true));
      writeFileSync(database, mongoUnit(release, join(directory, 'mongod.conf')));
      const result = spawnSync('systemd-analyze', ['verify', bot, database], { encoding: 'utf8' });
      expect(result.error, 'systemd-analyze is required on deployment/test hosts').toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
