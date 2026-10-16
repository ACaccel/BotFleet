/** The whitelist exposes member IDs and model choices, so only bot admins may list it. */
import { describe, expect, it, vi } from 'vitest';

import AiWhitelistList from '../../../../src/handlers/commands/ai_whitelist_list/action';
import {
  buildChatInputInteraction,
  newInteractionSink,
} from '../../../fixtures/discord/interaction-builder';
import { buildFakeBot } from '../../../fixtures/discord/bot-fake';

describe('/ai whitelist list', () => {
  it('refuses a member who is not a bot admin before reading the whitelist', async () => {
    const sink = newInteractionSink();
    const listAll = vi.fn();
    const { bot } = buildFakeBot({
      isAdmin: () => false,
      getRepos: () => ({ userApiSetting: { listAll } }),
    });

    await new AiWhitelistList().execute(buildChatInputInteraction({ sink }), bot);

    expect(sink.editReplies).toEqual([{ content: 'errors:permission.admin_only_short' }]);
    expect(listAll).not.toHaveBeenCalled();
  });
});
