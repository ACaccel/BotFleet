import { describe, expect, it, vi, afterEach } from 'vitest';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import {
  deploymentSchema,
  mergeTargetRelease,
  parseAction,
  ownerMarker,
  validateRelease,
  type Release,
} from '../../../scripts/deployment/config';
import { botUnit, mongoUnit } from '../../../scripts/deployment/units';
import {
  applyUnits,
  restore,
  type ServiceOps,
  type Transaction,
  type UnitState,
} from '../../../scripts/deployment/transaction';
import { inspectUnit, readyMarkerMatches, serviceOps } from '../../../scripts/deployment/host';

import { waitForMongo } from '../../../scripts/deployment/mongo-probe';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  spawnSync: vi.fn(),
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
  existsSync: vi.fn(),
  lstatSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('../../../scripts/deployment/mongo-probe', () => ({ waitForMongo: vi.fn() }));

const bot = 'pleiades@nijika.service';
function release(root = '/srv/pleiades-fleet'): Release {
  return {
    root,
    directory: `${root}/.deploy/releases/example`,
    prefix: `${root}/.conda`,
    config: deploymentSchema.parse({
      user: 'operator',
      bots: ['nijika'],
      mongodb: {
        prefix: '/srv/mongodb/.conda',
        configFile: '/srv/mongodb/mongod.conf',
        probeEnvFile: '/srv/mongodb/probe.env',
      },
    }),
    units: {},
  };
}
const absent = (): UnitState => ({ content: null, enabled: false, active: false });
function fakeOps(initial: Record<string, UnitState> = {}) {
  const states = structuredClone(initial);
  let journal: Transaction | null = null;
  const events: string[] = [];
  const ops: ServiceOps = {
    inspect: vi.fn((name) => structuredClone(states[name] ?? absent())),
    write: vi.fn((name, content) => {
      events.push(`write ${name}`);
      states[name] = { ...(states[name] ?? absent()), content };
    }),
    system: vi.fn((action, name) => {
      events.push(`${action} ${name ?? ''}`);
      if (!name) return;
      const state = states[name] ?? (states[name] = absent());
      if (action === 'start') state.active = true;
      if (action === 'stop') state.active = false;
      if (action === 'enable') state.enabled = true;
      if (action === 'disable') state.enabled = false;
    }),
    ready: vi.fn(async (name) => {
      events.push(`ready ${name}`);
    }),
    journal: vi.fn((value) => {
      journal = value;
    }),
  };
  return { ops, states, events, journal: () => journal };
}
afterEach(() => vi.resetAllMocks());

describe('deployment configuration and command boundaries', () => {
  it('rejects root, duplicate bots, relative prefixes and unknown settings', () => {
    const config = release().config;
    for (const patch of [
      { user: 'root' },
      { bots: ['nijika', 'nijika'] },
      { runtimePrefix: './.conda' },
      { bots: ['unregistered'] },
      { readinessTimeoutSeconds: 0 },
      { token: 'not-allowed' },
    ]) {
      expect(deploymentSchema.safeParse({ ...config, ...patch }).success).toBe(false);
    }
  });
  it('rejects legacy registration arguments before service work starts', () => {
    for (const flag of [
      '--dev-guild',
      '--dry-run',
      '--keep-guild-commands',
      '--cleanup-guild-commands',
    ]) {
      expect(() => parseAction(['deploy', flag])).toThrow('npm run register -t <bot>');
    }
    expect(parseAction(['recover'])).toEqual({ action: 'recover' });
    expect(() => parseAction(['unknown'])).toThrow('Usage');
  });
  it('selects one bot from argv or from flags npm consumed', () => {
    const tomori = { action: 'deploy', bot: 'tomori' };
    expect(parseAction(['deploy', '-t', 'tomori'])).toEqual(tomori);
    expect(parseAction(['deploy', '--target=tomori'])).toEqual(tomori);
    expect(parseAction(['deploy', 'tomori'], { t: 'true' })).toEqual(tomori);
    expect(parseAction(['deploy'], { target: 'tomori' })).toEqual(tomori);
    expect(parseAction(['prepare', 'tomori'], { t: 'true' })).toEqual({
      action: 'prepare',
      bot: 'tomori',
    });
    expect(parseAction(['deploy'])).toEqual({ action: 'deploy' });
  });
  it('rejects ambiguous, unknown or misplaced bot selections', () => {
    expect(() => parseAction(['deploy', '-t'])).toThrow('requires a bot name');
    expect(() => parseAction(['deploy'], { t: 'true' })).toThrow('single bot');
    expect(() => parseAction(['deploy', 'tomori'])).toThrow('single bot');
    expect(() => parseAction(['deploy', 'tomori', 'nijika'], { t: 'true' })).toThrow('single bot');
    expect(() => parseAction(['deploy', '-t', 'tomori'], { target: 'nijika' })).toThrow(
      'Conflicting',
    );
    expect(() => parseAction(['deploy', '-t', 'unregistered'])).toThrow('Unknown bot');
    for (const action of ['undeploy', 'recover', 'mongo-deploy'])
      expect(() => parseAction([action, '-t', 'tomori'])).toThrow('only to prepare and deploy');
  });
  it('replaces only the targeted service in the recorded deployment', () => {
    const previous = {
      ...release(),
      units: {
        'pleiades@tomori.service': 'old tomori',
        'pleiades@nijika.service': 'old nijika',
      },
    };
    const next = {
      ...release(),
      directory: '/srv/pleiades-fleet/.deploy/releases/next',
      units: { 'pleiades@tomori.service': 'new tomori' },
    };
    expect(mergeTargetRelease(previous, next, 'tomori')).toEqual({
      ...next,
      units: { 'pleiades@tomori.service': 'new tomori', 'pleiades@nijika.service': 'old nijika' },
    });
    expect(mergeTargetRelease(undefined, next, 'tomori').units).toEqual(next.units);
    expect(() => mergeTargetRelease(previous, next, 'nijika')).toThrow('no service for nijika');
  });
  it('rejects release manifests outside this project release directory', () => {
    expect(() =>
      validateRelease({ ...release(), directory: '/tmp/foreign' }, '/srv/pleiades-fleet'),
    ).toThrow();
    expect(() =>
      validateRelease(
        { ...release(), directory: '/srv/pleiades-fleet/.deploy/releases/../outside' },
        '/srv/pleiades-fleet',
      ),
    ).toThrow();
    expect(() => validateRelease(release(), '/srv/Other')).toThrow();
  });
  it('rejects malformed manifests and foreign or traversing unit names', () => {
    const root = '/srv/pleiades-fleet';
    for (const value of [
      null,
      {},
      { ...release(), units: null },
      { ...release(), prefix: '../.conda' },
      { ...release(), units: { '../foreign.service': ownerMarker(root) } },
      { ...release(), units: { [bot]: ownerMarker('/srv/Other') } },
      { ...release(), units: { 'unrelated.service': ownerMarker(root) } },
    ]) {
      expect(() => validateRelease(value, root)).toThrow();
    }
    const valid = { ...release(), units: { [bot]: ownerMarker(root) + '[Unit]\n' } };
    expect(validateRelease(valid, root)).toEqual(valid);
  });
});

describe('systemd runtime and argument rendering', () => {
  it('preserves spaces, literal percent and dollar characters in executable arguments', () => {
    const unit = botUnit(release('/srv/a b%$HOME'), 'nijika', true);
    expect(unit).toContain('ExecStart="/srv/a b%%$HOME/.conda/bin/node"');
    expect(unit).toContain('WorkingDirectory=/srv/a b%%$HOME/.deploy/releases/example');
    expect(unit).toContain('Environment="CONDA_PREFIX=/srv/a b%%$HOME/.conda"');
    expect(unit).toContain('"/srv/a b%%$$HOME/.deploy/releases/example/src/bot/nijika/index.ts"');
    expect(unit).toContain('KillMode=control-group');
    expect(unit).toContain('RuntimeDirectory=pleiades-nijika');
    expect(unit).toContain('ExecStartPre=');
    expect(unit).toContain('Wants=network-online.target mongodb-pleiades.service');
  });
  it('omits database start dependencies and probes for a bot that does not use MongoDB', () => {
    const unit = botUnit(release(), 'gopher', false);
    expect(unit).not.toContain('ExecStartPre=');
    expect(unit).not.toContain('mongodb-pleiades.service');
  });
  it('uses the separate MongoDB executable and rejects line injection', () => {
    const unit = mongoUnit(release(), '/srv/db config%$HOME.json');
    expect(unit).toContain(
      'ExecStart="/srv/mongodb/.conda/bin/mongod" "--config" "/srv/db config%%$$HOME.json"',
    );
    expect(unit).not.toContain('fork');
    expect(() => mongoUnit(release(), '/tmp/config\nExecStart=/bin/false')).toThrow();
  });
});

describe('readiness markers', () => {
  it('requires matching live PID and a fresh completed startup', () => {
    const marker = { pid: 123, startedAt: 100, readyAt: 120 };
    expect(readyMarkerMatches(marker, 123, 110)).toBe(true);
    expect(readyMarkerMatches(marker, 124, 110)).toBe(false);
    expect(readyMarkerMatches(marker, 123, 121)).toBe(false);
    expect(readyMarkerMatches(marker, 0, 110)).toBe(false);
    expect(readyMarkerMatches({ ...marker, readyAt: 99 }, 123, 90)).toBe(false);
    expect(readyMarkerMatches(null, 123, 110)).toBe(false);
  });
});

describe('service deployment transaction', () => {
  it('commits only after every replacement has reported readiness', async () => {
    const old = { content: 'old', active: true, enabled: true };
    const state = fakeOps({ [bot]: old });
    const commit = vi.fn(() => {
      expect(state.events).toContain(`ready ${bot}`);
      expect(state.journal()).not.toBeNull();
    });
    await applyUnits({ [bot]: 'new' }, state.ops, commit);
    expect(state.states[bot]).toEqual({ content: 'new', active: true, enabled: true });
    expect(commit).toHaveBeenCalledOnce();
    expect(state.journal()).toBeNull();
    expect(state.events.indexOf(`stop ${bot}`)).toBeLessThan(state.events.indexOf(`write ${bot}`));
  });
  it('restores previous unit content and enabled/active states after readiness failure', async () => {
    const old = { content: 'old', active: true, enabled: false };
    const state = fakeOps({ [bot]: old });
    vi.mocked(state.ops.ready).mockRejectedValueOnce(new Error('Discord not ready'));
    const commit = vi.fn();
    await expect(applyUnits({ [bot]: 'new' }, state.ops, commit)).rejects.toThrow(
      'Discord not ready',
    );
    expect(state.states[bot]).toEqual(old);
    expect(commit).not.toHaveBeenCalled();
    expect(state.journal()).toBeNull();
  });
  it('removes newly added units when another bot fails and preserves disabled existing services', async () => {
    const second = 'pleiades@tomori.service';
    const initial = { [bot]: { content: 'old', enabled: false, active: false } };
    const state = fakeOps(initial);
    vi.mocked(state.ops.ready).mockRejectedValueOnce(new Error('startup failed'));
    await expect(
      applyUnits({ [bot]: 'new', [second]: 'added' }, state.ops, vi.fn()),
    ).rejects.toThrow();
    expect(state.states[bot]).toEqual(initial[bot]);
    expect(state.states[second]).toEqual(absent());
  });
  it('removes bot services without touching the MongoDB service', async () => {
    const mongo = 'mongodb-pleiades.service';
    const state = fakeOps({
      [bot]: { content: 'bot', enabled: true, active: true },
      [mongo]: { content: 'db', enabled: true, active: true },
    });
    await applyUnits({ [bot]: null }, state.ops, vi.fn());
    expect(state.states[bot]).toEqual(absent());
    expect(state.states[mongo]).toEqual({ content: 'db', enabled: true, active: true });
    expect(state.ops.ready).not.toHaveBeenCalled();
  });
  it('retains the recovery journal when rollback cannot restore unit content', async () => {
    const state = fakeOps({ [bot]: { content: 'old', enabled: true, active: true } });
    vi.mocked(state.ops.ready).mockRejectedValueOnce(new Error('not ready'));
    vi.mocked(state.ops.write)
      .mockImplementationOnce((name, content) => {
        state.states[name] = { ...(state.states[name] ?? absent()), content };
      })
      .mockImplementationOnce(() => {
        throw new Error('disk failure');
      });
    await expect(applyUnits({ [bot]: 'new' }, state.ops, vi.fn())).rejects.toThrow(
      'rollback requires',
    );
    expect(state.journal()).not.toBeNull();
  });
  it('does not stop or disable a new unit whose installation failed before creation', async () => {
    const state = fakeOps();
    vi.mocked(state.ops.write).mockImplementationOnce(() => {
      throw new Error('install failed');
    });
    await expect(applyUnits({ [bot]: 'new' }, state.ops, vi.fn())).rejects.toThrow(
      'install failed',
    );
    expect(state.ops.system).not.toHaveBeenCalledWith('stop', bot);
    expect(state.ops.system).not.toHaveBeenCalledWith('disable', bot);
    expect(state.journal()).toBeNull();
  });
  it('preserves committed services if clearing the durable journal fails', async () => {
    const state = fakeOps({ [bot]: { content: 'old', enabled: true, active: true } });
    vi.mocked(state.ops.journal).mockImplementation((value) => {
      if (value === null) throw new Error('journal cleanup failed');
    });
    const commit = vi.fn();
    await expect(applyUnits({ [bot]: 'new' }, state.ops, commit)).rejects.toThrow(
      'journal cleanup failed',
    );
    expect(commit).toHaveBeenCalledOnce();
    expect(state.states[bot]).toEqual({ content: 'new', enabled: true, active: true });
  });
  it('keeps recovery pending when the restored bot fails its own readiness check', async () => {
    const state = fakeOps({ [bot]: { content: 'old', enabled: true, active: true } });
    vi.mocked(state.ops.ready).mockRejectedValue(new Error('Discord unavailable'));
    await expect(applyUnits({ [bot]: 'new' }, state.ops, vi.fn())).rejects.toThrow(
      'rollback requires',
    );
    expect(state.ops.ready).toHaveBeenCalledTimes(2);
    expect(state.ops.ready).toHaveBeenLastCalledWith(bot, true);
    expect(state.ops.inspect).toHaveBeenCalledWith(bot, true);
    expect(state.journal()).not.toBeNull();
  });
  it('rejects unmanaged units before recording a transaction or performing mutations', async () => {
    const state = fakeOps();
    vi.mocked(state.ops.inspect).mockImplementation(() => {
      throw new Error('Refusing unmanaged unit');
    });
    await expect(applyUnits({ [bot]: 'new' }, state.ops, vi.fn())).rejects.toThrow('unmanaged');
    expect(state.ops.journal).not.toHaveBeenCalled();
    expect(state.ops.write).not.toHaveBeenCalled();
    expect(state.ops.system).not.toHaveBeenCalled();
  });
  it('still attempts to restart prior services when daemon reload fails', async () => {
    const state = fakeOps();
    vi.mocked(state.ops.system).mockImplementationOnce(() => {
      throw new Error('reload failed');
    });
    await expect(
      restore(
        {
          before: { [bot]: { content: 'old', enabled: true, active: true } },
          after: { [bot]: 'new' },
        },
        state.ops,
      ),
    ).rejects.toThrow('Rollback incomplete');
    expect(state.ops.write).toHaveBeenCalledWith(bot, 'old');
    expect(state.ops.system).toHaveBeenCalledWith('start', bot);
  });
});

describe('host ownership checks', () => {
  function fields(values: Record<string, string>) {
    vi.mocked(childProcess.spawnSync).mockImplementation((_command: unknown, args: unknown) => {
      const property =
        (args as string[]).find((value) => value.startsWith('--property='))?.slice(11) ?? '';
      return {
        pid: 1,
        output: [],
        stdout: values[property] ?? '',
        stderr: '',
        status: 0,
        signal: null,
      };
    });
  }
  it('allows recovery to inspect and stop an auto-restarting unit while normal deployment refuses it', () => {
    fields({ ActiveState: 'activating', UnitFileState: 'enabled' });
    expect(() => inspectUnit('/srv/pleiades-fleet', bot)).toThrow('changing state');
    expect(inspectUnit('/srv/pleiades-fleet', bot, true)).toEqual({
      content: null,
      enabled: true,
      active: true,
    });
  });
  it('uses the restored MongoDB probe configuration during rollback', async () => {
    fields({ ActiveState: 'active' });
    const current = release();
    const previous = release();
    current.config.mongodb = {
      prefix: '/srv/new/.conda',
      configFile: '/srv/new/mongod.conf',
      probeEnvFile: '/srv/new/probe.env',
    };
    previous.config.mongodb = {
      prefix: '/srv/old/.conda',
      configFile: '/srv/old/mongod.conf',
      probeEnvFile: '/srv/old/probe.env',
    };
    previous.config.readinessTimeoutSeconds = 45;
    const ops = serviceOps(current, vi.fn(), previous);
    await ops.ready('mongodb-pleiades.service');
    expect(waitForMongo).toHaveBeenLastCalledWith('/srv/new/probe.env', 120);
    await ops.ready('mongodb-pleiades.service', true);
    expect(waitForMongo).toHaveBeenLastCalledWith('/srv/old/probe.env', 45);
  });
  it('refuses foreign fragments and drop-in overrides', () => {
    fields({ FragmentPath: `/usr/lib/systemd/system/${bot}` });
    expect(() => inspectUnit('/srv/pleiades-fleet', bot)).toThrow('another service definition');
    vi.resetAllMocks();
    fields({ DropInPaths: '/etc/systemd/system/override.conf' });
    expect(() => inspectUnit('/srv/pleiades-fleet', bot)).toThrow('overrides');
  });
  it('refuses same-name units owned by another checkout', () => {
    fields({ FragmentPath: `/etc/systemd/system/${bot}` });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.lstatSync).mockReturnValue({ isFile: () => true } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(ownerMarker('/srv/Other'));
    expect(() => inspectUnit('/srv/pleiades-fleet', bot)).toThrow('unmanaged');
  });
});
