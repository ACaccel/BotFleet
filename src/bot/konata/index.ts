import { Konata } from './konata';
import config from './config.json';

import { bootstrapPersonality, MESSAGE_BOT_INTENTS } from '../bootstrap';

bootstrapPersonality({
  name: 'konata',
  intents: MESSAGE_BOT_INTENTS,
  // `loadEnv` already requires a long enough `NOTIFY_API_KEY` whenever
  // `NOTIFY_API_PORT` is set; without a port the relay API stays off.
  build: (client, env) =>
    new Konata(client, env.TOKEN, env.MONGO_URI ?? '', env.CLIENT_ID, config, {
      port: env.NOTIFY_API_PORT,
      apiKey: env.NOTIFY_API_KEY,
    }),
});
