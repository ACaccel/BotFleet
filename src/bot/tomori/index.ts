import { Tomori } from './tomori';
import config from './config.json';

import { bootstrapPersonality, DM_PARTIALS, GUILD_OBSERVER_INTENTS } from '../bootstrap';

bootstrapPersonality({
  name: 'tomori',
  intents: GUILD_OBSERVER_INTENTS,
  // `/bug_report` replies reach the bot as DMs.
  partials: DM_PARTIALS,
  build: (client, env) =>
    new Tomori(client, env.TOKEN, env.MONGO_URI ?? '', env.CLIENT_ID, config, {
      alertPort: env.EARTHQUAKE_ALERT_PORT,
      alertKey: env.EARTHQUAKE_ALERT_KEY,
      cwaApiKey: env.CWA_API_KEY,
    }),
});
