import type { Client } from 'discord.js';

import type { Config } from '@bot';
import { BaseBot } from '@bot';
import { createIdentitySyncPlugin, createLlmAutoReplyPlugin } from '@plugins';

interface GopherConfig extends Config {
  /**
   * Raw `llm_auto_reply` block. Parsed and defaulted by the plugin
   * (see `createLlmAutoReplyPlugin`), so it is intentionally `unknown`
   * here and may be omitted entirely.
   */
  llm_auto_reply?: unknown;
  /** Raw `identity_sync` block, parsed by `createIdentitySyncPlugin`. */
  identity_sync?: unknown;
}

/**
 * Gopher composition root. A focused, database-free personality whose job
 * is the self-hosted LLM auto-reply and daily avatar/nickname identity
 * sync. Configuration is read at startup; endpoint changes require a restart.
 */
export class Gopher extends BaseBot<GopherConfig> {
  public constructor(
    client: Client,
    token: string,
    mongoURI: string,
    clientId: string,
    config: GopherConfig,
  ) {
    super(client, token, mongoURI, clientId, config);
    this.helpMessageKey = 'replies:gopher.help_message';

    this.use(
      createLlmAutoReplyPlugin(this.config.llm_auto_reply, {
        clientId: this.clientId,
      }),
    );
    // Daily avatar/nickname sync with a source user (or static fallback).
    this.use(createIdentitySyncPlugin(this.config.identity_sync));
  }
}
