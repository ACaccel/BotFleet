/* eslint-disable import/first */
import { describe, expect, it, vi } from 'vitest';
import type * as Bootstrap from '../../../src/bot/bootstrap';

import { barrelStubs } from '../../fixtures/handler-barrel-stubs';
import { buildInertClient } from '../../fixtures/discord/client-builder';

vi.mock('@cmd', () => barrelStubs.cmd);
vi.mock('@button', () => barrelStubs.button);
vi.mock('@modal', () => barrelStubs.modal);
vi.mock('@select-menu', () => barrelStubs.selectMenu);
vi.mock('../../../src/bot/gopher/config.json', () => ({ default: { commands: ['help'] } }));
vi.mock('../../../src/bot/bootstrap', async (original) => ({
  ...(await original<typeof Bootstrap>()),
  bootstrapPersonality: vi.fn(),
}));

import { bootstrapPersonality } from '../../../src/bot/bootstrap';
import { loadEnv } from '../../../src/core/config/env';
import { Gopher } from '../../../src/bot/gopher/gopher';
import '../../../src/bot/gopher/index';

describe('Gopher startup', () => {
  it('validates and constructs with only Discord credentials', () => {
    expect(bootstrapPersonality).toHaveBeenCalledTimes(1);
    const [options] = vi.mocked(bootstrapPersonality).mock.calls[0]!;
    const env = loadEnv({
      ...options.env,
      exitOnFailure: false,
      source: { TOKEN: 'valid-bot-token', CLIENT_ID: '123456789012345678' },
    });

    expect(env.PORT).toBeUndefined();
    expect(env.MONGO_URI).toBeUndefined();
    expect(options.build(buildInertClient(), env)).toBeInstanceOf(Gopher);
  });
});
