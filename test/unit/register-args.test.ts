/**
 * Unit tests for {@link parseRegisterArgs}.
 *
 * npm 10 consumes flags given without a `--` separator: `npm run register
 * -t nijika --dry-run` reaches the script as argv `["nijika"]` with
 * `npm_config_t=true` and `npm_config_dry_run=true`. These pin that both
 * that shape and the legacy `--` shape resolve to the same options, and
 * that ambiguous input is rejected instead of guessed at.
 */
import { describe, expect, it } from 'vitest';

import {
  parseRegisterArgs,
  RegisterUsageError,
  type RegisterArgs,
  type RegisterNpmFlags,
} from '../../src/register-args';

const KNOWN_BOTS = ['gopher', 'konata', 'msg-archive', 'nijika', 'tomori'] as const;
const GUILD = '123456789012345678';
const OTHER_GUILD = '876543210987654321';

const DEFAULTS: RegisterArgs = {
  bot: undefined,
  devGuild: undefined,
  dryRun: false,
  keepGuildCommands: false,
  cleanupGuildCommands: false,
};

const parse = (argv: readonly string[], npmFlags: RegisterNpmFlags = {}): RegisterArgs =>
  parseRegisterArgs(argv, npmFlags, KNOWN_BOTS);

const expectUsageError = (
  argv: readonly string[],
  npmFlags: RegisterNpmFlags,
  message: RegExp,
): void => {
  expect(() => parse(argv, npmFlags)).toThrow(RegisterUsageError);
  expect(() => parse(argv, npmFlags)).toThrow(message);
};

describe('parseRegisterArgs', () => {
  describe('target bot', () => {
    it('targets every bot when no bot is named', () => {
      expect(parse([])).toEqual(DEFAULTS);
    });

    it('takes the bot from the positional npm left behind after consuming -t', () => {
      expect(parse(['nijika'], { t: 'true' })).toEqual({ ...DEFAULTS, bot: 'nijika' });
    });

    it.each(['target', 'b', 'bot'] as const)('treats a bare npm --%s like -t', (flag) => {
      expect(parse(['konata'], { [flag]: 'true' }).bot).toBe('konata');
    });

    it('takes the bot from an npm flag value (-t=<bot>)', () => {
      expect(parse([], { t: 'tomori' }).bot).toBe('tomori');
    });

    it.each([
      [['-t', 'nijika']],
      [['--target', 'nijika']],
      [['-b', 'nijika']],
      [['--bot', 'nijika']],
      [['--target=nijika']],
    ])('accepts the legacy "--" form %j', (argv) => {
      expect(parse(argv).bot).toBe('nijika');
    });

    it('accepts a bare bot name positional', () => {
      expect(parse(['msg-archive']).bot).toBe('msg-archive');
    });

    it('accepts the same bot named twice', () => {
      expect(parse(['-t', 'nijika', 'nijika']).bot).toBe('nijika');
    });

    it('rejects an unknown bot and lists the known ones', () => {
      expectUsageError(['nijka'], { t: 'true' }, /Unknown bot "nijka".*nijika/);
      expectUsageError(['-t', '../etc'], {}, /Unknown bot/);
      expectUsageError([], { target: 'nope' }, /Unknown bot "nope"/);
      expect(() => parseRegisterArgs(['nijika'], {}, [])).toThrow(/Known bots: \(none found\)/);
    });

    it('rejects two different bot names', () => {
      expectUsageError(['nijika', 'konata'], { t: 'true' }, /at most one bot name/);
      expectUsageError(['-t', 'nijika'], { t: 'konata' }, /Conflicting bot values/);
      expectUsageError(['-t', 'nijika', 'konata'], {}, /Conflicting bot values/);
    });

    it('rejects -t without a bot name', () => {
      expectUsageError([], { t: 'true' }, /requires a bot name/);
      expectUsageError(['-t'], {}, /requires a bot name/);
      expectUsageError(['-t', '--dry-run'], {}, /requires a bot name/);
    });

    it('ignores npm bot flags that were explicitly disabled', () => {
      expect(parse([], { t: 'false', target: '' }).bot).toBeUndefined();
    });
  });

  describe('snowflake vs bot name positionals', () => {
    it('does not mistake a guild id for a bot name', () => {
      expect(parse(['nijika', GUILD], { t: 'true', 'dev-guild': 'true' })).toEqual({
        ...DEFAULTS,
        bot: 'nijika',
        devGuild: GUILD,
      });
    });

    it('resolves positionals regardless of order', () => {
      expect(parse([GUILD, 'nijika'], { t: 'true', 'dev-guild': 'true' })).toMatchObject({
        bot: 'nijika',
        devGuild: GUILD,
      });
    });

    it('rejects a guild id positional without --dev-guild', () => {
      expectUsageError(['nijika', GUILD], { t: 'true' }, /Unexpected guild id/);
    });

    it('rejects two guild id positionals', () => {
      expectUsageError(
        ['nijika', GUILD, OTHER_GUILD],
        { t: 'true', 'dev-guild': 'true' },
        /at most one guild id/,
      );
    });

    it('rejects a short digit string as an unknown bot rather than a guild', () => {
      expectUsageError(['123'], { 'dev-guild': 'true' }, /Unknown bot "123"/);
    });
  });

  describe('boolean flags', () => {
    it.each([
      ['dry-run', 'dryRun'],
      ['keep-guild-commands', 'keepGuildCommands'],
      ['cleanup-guild-commands', 'cleanupGuildCommands'],
    ] as const)('honours --%s from the npm environment', (flag, option) => {
      expect(parse(['nijika'], { t: 'true', [flag]: 'true' })[option]).toBe(true);
    });

    it.each([
      ['--dry-run', 'dryRun'],
      ['--keep-guild-commands', 'keepGuildCommands'],
      ['--cleanup-guild-commands', 'cleanupGuildCommands'],
    ] as const)('honours %s from argv', (flag, option) => {
      expect(parse(['-t', 'nijika', flag])[option]).toBe(true);
    });

    it('applies boolean flags to an all-bots run', () => {
      expect(parse([], { 'dry-run': 'true' })).toEqual({ ...DEFAULTS, dryRun: true });
      expect(parse(['--keep-guild-commands'])).toEqual({ ...DEFAULTS, keepGuildCommands: true });
    });

    it('treats a disabled npm flag as off', () => {
      expect(parse([], { 'dry-run': 'false' }).dryRun).toBe(false);
      expect(parse([], { 'dry-run': '' }).dryRun).toBe(false);
    });

    it('rejects contradictory guild-command flags', () => {
      expectUsageError(
        ['--cleanup-guild-commands', '--keep-guild-commands'],
        {},
        /cannot be combined with --keep-guild-commands/,
      );
      expectUsageError(
        ['nijika'],
        { t: 'true', 'cleanup-guild-commands': 'true', 'dev-guild': GUILD },
        /cannot be combined with --dev-guild/,
      );
    });

    it('rejects an unknown option', () => {
      expectUsageError(['-t', 'nijika', '--dryrun'], {}, /Unknown option "--dryrun"/);
    });
  });

  describe('--dev-guild', () => {
    it('reads the value after --dev-guild in argv (legacy "--" form)', () => {
      expect(parse(['-t', 'nijika', '--dev-guild', GUILD]).devGuild).toBe(GUILD);
      expect(parse(['-t', 'nijika', `--dev-guild=${GUILD}`]).devGuild).toBe(GUILD);
    });

    it('reads a snowflake npm value (--dev-guild=<id>)', () => {
      expect(parse(['nijika'], { t: 'true', 'dev-guild': GUILD }).devGuild).toBe(GUILD);
    });

    it('takes the positional snowflake when npm consumed a bare --dev-guild', () => {
      expect(parse(['nijika', GUILD], { t: 'true', 'dev-guild': 'true' }).devGuild).toBe(GUILD);
    });

    it('rejects a bare --dev-guild without a guild id', () => {
      expectUsageError(['nijika'], { t: 'true', 'dev-guild': 'true' }, /requires a guild id/);
      expectUsageError(['-t', 'nijika', '--dev-guild'], {}, /requires a guild id/);
    });

    it('rejects a non-snowflake guild id', () => {
      expectUsageError(['nijika'], { t: 'true', 'dev-guild': 'abc' }, /Invalid --dev-guild/);
      expectUsageError(['-t', 'nijika', '--dev-guild', 'abc'], {}, /Invalid --dev-guild/);
    });

    it('rejects two different guild ids', () => {
      expectUsageError(
        ['-t', 'nijika', '--dev-guild', GUILD],
        { 'dev-guild': OTHER_GUILD },
        /Conflicting --dev-guild values/,
      );
    });

    it('requires a target bot', () => {
      expectUsageError([GUILD], { 'dev-guild': 'true' }, /pass -t <bot_name>/);
      expectUsageError([], { 'dev-guild': GUILD }, /pass -t <bot_name>/);
    });
  });
});
