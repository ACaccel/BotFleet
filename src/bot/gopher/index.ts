import { Gopher } from './gopher';
import config from './config.json';

import { bootstrapPersonality, MESSAGE_BOT_INTENTS } from '../bootstrap';

// Gopher has no per-guild repositories or inbound HTTP server.
bootstrapPersonality({
  name: 'gopher',
  intents: MESSAGE_BOT_INTENTS,
  env: { requireDb: false },
  build: (client, env) => new Gopher(client, env.TOKEN, env.MONGO_URI ?? '', env.CLIENT_ID, config),
});
