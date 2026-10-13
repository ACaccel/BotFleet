import type { Client } from 'discord.js';
import { ActivityType, Events } from 'discord.js';

import type { Config } from '@bot';
import { BaseBot } from '@bot';
import type { ClientEventBridgeSuppression } from '../client-event-bridge';
import { createLlmChatPlugin } from '@plugins';
import { parseAiPolicy } from '../../application/ai/policy';

/**
 * Konata composition root. The entire LLM chat lifecycle (session
 * management, provider dispatch, chunked reply, pre-warm) lives in
 * {@link createLlmChatPlugin}; this class registers that plugin and a
 * Discord presence.
 *
 * Listener policy: Konata is a pure LLM-chat bot. It opts out of the
 * reaction and guildCreate raw listeners through the
 * `eventBridgeSuppression` hook so the bridge does not install them.
 */
export class Konata extends BaseBot<Config> {
  public constructor(
    client: Client,
    token: string,
    mongoURI: string,
    clientId: string,
    config: Config,
  ) {
    super(client, token, mongoURI, clientId, config);
    this.use(
      createLlmChatPlugin({
        clientId: this.clientId,
        // Parsed here so a malformed `ai` block stops startup.
        policy: parseAiPolicy(config),
        isAdmin: (userId) => this.isAdmin(userId),
      }),
    );
    this.registerPresence();
  }

  protected override eventBridgeSuppression(): ClientEventBridgeSuppression {
    return { reaction: true, guildCreate: true };
  }

  /**
   * Without an explicit presence, Discord clients tend to render an idle bot
   * as offline even though its gateway session is still alive. Register a
   * ready-time presence so konata reliably appears online with a custom
   * status line.
   */
  private registerPresence(): void {
    this.client.once(Events.ClientReady, () => {
      const text = this.translator?.t('replies:konata.presence_text') ?? '';
      if (text.length === 0) return;
      this.client.user?.setPresence({
        status: 'online',
        activities: [
          {
            name: text,
            type: ActivityType.Custom,
            state: text,
          },
        ],
      });
    });
  }
}
