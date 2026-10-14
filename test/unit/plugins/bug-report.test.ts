import { describe, expect, it, vi } from 'vitest';

import { createBugReportPlugin } from '../../../src/plugins/bug-report';
import type { PluginEventContext, PluginRuntimeContext } from '../../../src/core/plugin';

describe('bug-report plugin', () => {
  it('does nothing for a bot without a bug_report block', async () => {
    const resolve = vi.fn();
    const plugin = createBugReportPlugin({
      config: undefined,
      isAdmin: () => false,
      label: () => 'Bot',
    });

    await plugin.onReady?.({ resolve } as unknown as PluginRuntimeContext);
    await plugin.events?.messageCreate?.(
      { resolve } as unknown as PluginEventContext,
      {
        author: { bot: false },
        guildId: null,
      } as never,
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
