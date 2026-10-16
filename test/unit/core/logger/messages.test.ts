import { describe, expect, it } from 'vitest';

import { ops } from '../../../../src/core/logger';

describe('ops messages catalog', () => {
  it('renders command-area lines with stable ops: prefix', () => {
    expect(ops.command.registerStart()).toMatch(/^ops:command\.register_start/);
    expect(ops.command.registerEmpty()).toMatch(/^ops:command\.register_empty/);
    expect(ops.command.registerSuccess(7)).toMatch(/registered 7/);
    expect(ops.command.registerFailed('sample_command')).toMatch(
      /Failed to register command sample_command/,
    );
    expect(ops.command.guildSyncFailed('g1')).toMatch(/Failed to sync commands for guild g1/);
    expect(ops.command.handlerMissingConfig('foo')).toMatch(/Command foo has no config/);
  });

  it('renders guildDb-area lines with the right interpolations', () => {
    expect(ops.guildDb.slotMissing('g-1')).toMatch(/g-1/);
    expect(ops.guildDb.connectFailed('g-1', 'abc', 'down')).toMatch(/traceId=abc.*down/);
    expect(ops.guildDb.connectSuccess('g-1', 'Server')).toMatch(/g-1 - Server/);
    expect(ops.guildDb.poolStartFailed('refused')).toMatch(/refused/);
    expect(ops.guildDb.uriMissing()).toMatch(/uri_missing/);
    expect(ops.guildDb.poolStart()).toMatch(/pool_start/);
  });

  it('renders router-area replySkipped with the discord error code', () => {
    expect(ops.router.replySkipped(40060)).toMatch(/code=40060/);
    expect(ops.router.replySkipped('Unknown')).toMatch(/code=Unknown/);
  });
});
