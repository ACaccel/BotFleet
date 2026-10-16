import { describe, expect, it, vi } from 'vitest';

import { createBugReportPlugin } from '../../../src/plugins/bug-report';
import { buildMessage } from '../../fixtures/discord/message-builder';
import { buildPluginContext } from '../../fixtures/runtime';

describe('bug-report plugin', () => {
  it('does nothing for a bot without a bug_report block', async () => {
    const resolve = vi.fn();
    const ctx = buildPluginContext({ resolve });
    const plugin = createBugReportPlugin({
      config: undefined,
      isAdmin: () => false,
      label: () => 'Bot',
    });

    await plugin.onReady?.(ctx);
    await plugin.events?.messageCreate?.(
      ctx,
      buildMessage({ author: { bot: false }, guildId: null }) as never,
    );

    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects a malformed block when the bot is built', () => {
    expect(() =>
      createBugReportPlugin({
        config: { hub: { guildId: 'x' } },
        isAdmin: () => false,
        label: () => '',
      }),
    ).toThrow();
  });
});
