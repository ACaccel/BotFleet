import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Host from '../../../scripts/deployment/host';
import { makeRelease, validatePrefix } from '../../../scripts/deployment/release';
import type { DeploymentConfig } from '../../../scripts/deployment/config';

const commands = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../../scripts/deployment/host', async (original) => ({
  ...(await original<typeof Host>()),
  run: commands.run,
}));

let root: string;
let config: DeploymentConfig;
function file(relative: string, content = ''): string {
  const filename = join(root, relative);
  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(filename, content);
  return filename;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'botfleet-release-'));
  file('.conda/conda-meta/history');
  file('.conda/bin/node');
  file('src/bot/tomori/index.ts', 'export const revision = 1;');
  file(
    'src/bot/tomori/.env',
    'TOKEN=valid-token\nCLIENT_ID=123456\nMONGO_URI=mongodb://localhost/test\n',
  );
  file('src/bot/tomori/config.json', '{}');
  for (const name of ['package.json', 'tsconfig.json']) file(name, '{}');
  file('package-lock.json');
  file('scripts/mongo-ready.ts', 'export {};');
  file('scripts/deployment/mongo-probe.ts', 'export {};');
  file('node_modules/test-package/index.js', 'module.exports = 1;');
  config = { user: 'operator', bots: ['tomori'], readinessTimeoutSeconds: 120 };
  commands.run.mockReset();
  commands.run.mockImplementation((program: string, args: string[]) => {
    if (program.endsWith('/node') && args[0] === '--version') return 'v22.13.0';
    if (program.endsWith('/mongod')) return 'db version v7.0.34';
    if (program === 'git') return 'src/bot/tomori/.env\0src/bot/tomori/config.json\0';
    if (program === 'cp') cpSync(args[3]!, args[4]!, { recursive: true });
    return '';
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('release preparation', () => {
  it('freezes application code and dependencies while retaining shared local settings', () => {
    const release = makeRelease(root, config, false);
    file('src/bot/tomori/index.ts', 'export const revision = 2;');
    file('node_modules/test-package/index.js', 'module.exports = 2;');
    file('src/bot/tomori/config.json', '{"language":"en"}');
    expect(readFileSync(join(release.directory, 'src/bot/tomori/index.ts'), 'utf8')).toContain(
      'revision = 1',
    );
    expect(
      readFileSync(join(release.directory, 'node_modules/test-package/index.js'), 'utf8'),
    ).toContain('exports = 1');
    expect(lstatSync(join(release.directory, 'src/bot/tomori/.env')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(release.directory, 'src/bot/tomori/config.json'), 'utf8')).toBe(
      '{"language":"en"}',
    );
    expect(release.units['botfleet@tomori.service']).toContain(join(root, '.conda/bin/node'));
  });
  it('rejects missing settings and removes the incomplete release', () => {
    rmSync(join(root, 'src/bot/tomori/config.json'));
    expect(() => makeRelease(root, config, false)).toThrow('Missing config.json');
    expect(readdirSync(join(root, '.deploy/releases'))).toEqual([]);
  });
  it('rejects missing runtime and unsupported activation hooks', () => {
    expect(() => validatePrefix(join(root, 'missing'), 'node')).toThrow('Missing Conda runtime');
    file('.conda/etc/conda/activate.d/custom.sh', 'export REQUIRED_VALUE=1');
    expect(() => makeRelease(root, config, false)).toThrow('activation hooks');
    expect(existsSync(join(root, '.deploy/releases'))).toBe(false);
  });
  it('removes the incomplete release when systemd validation fails', () => {
    commands.run.mockImplementation((program: string, args: string[]) => {
      if (program.endsWith('/node') && args[0] === '--version') return 'v22.13.0';
      if (program === 'systemd-analyze') throw new Error('Invalid unit');
      return '';
    });
    expect(() => makeRelease(root, config, false)).toThrow('Invalid unit');
    expect(readdirSync(join(root, '.deploy/releases'))).toEqual([]);
  });
});

describe('MongoDB service preparation', () => {
  it('preserves original configuration and database contents while generating foreground configuration', () => {
    const prefix = join(root, 'mongo-runtime');
    file('mongo-runtime/conda-meta/history');
    file('mongo-runtime/bin/mongod');
    const marker = file('database/data/sentinel', 'existing data');
    const original = {
      storage: { dbPath: dirname(marker) },
      security: { authorization: 'enabled' },
      net: { bindIp: '127.0.0.1', port: 27017 },
      processManagement: { fork: true, pidFilePath: join(root, 'database/mongod.pid') },
    };
    const originalText = JSON.stringify(original);
    const configFile = file('database/mongod.conf', originalText);
    config.mongodb = { prefix, configFile, probeEnvFile: join(root, 'src/bot/tomori/.env') };
    const release = makeRelease(root, config, true);
    expect(readFileSync(configFile, 'utf8')).toBe(originalText);
    expect(readFileSync(join(release.directory, 'mongod.original.conf'), 'utf8')).toBe(
      originalText,
    );
    expect(readFileSync(marker, 'utf8')).toBe('existing data');
    expect(JSON.parse(readFileSync(join(release.directory, 'mongod.conf'), 'utf8'))).toEqual({
      ...original,
      processManagement: { fork: false },
    });
    expect(release.units['mongodb-botfleet.service']).toContain(join(prefix, 'bin/mongod'));
    expect(
      commands.run.mock.calls.some(([program]) => program === 'sudo' || program === 'systemctl'),
    ).toBe(false);
  });
});
