import { Nijika } from './nijika';
import config from './config.json';

import { bootstrapPersonality, DM_PARTIALS, GUILD_OBSERVER_INTENTS } from '../bootstrap';

bootstrapPersonality({
  name: 'nijika',
  intents: GUILD_OBSERVER_INTENTS,
  // `/bug_report` replies reach the bot as DMs.
  partials: DM_PARTIALS,
  // Both earthquake feeds are optional: `loadEnv` already requires a long
  // enough `EARTHQUAKE_ALERT_KEY` whenever `EARTHQUAKE_ALERT_PORT` is set,
  // the alert API stays off without a port, and report polling stays off
  // without `CWA_API_KEY`. `MONGO_INSPECT_URI` is checked by `Nijika` only
  // when `config.commands` lists `db`.
  build: (client, env) =>
    new Nijika(
      client,
      env.TOKEN,
      env.MONGO_URI ?? '',
      env.CLIENT_ID,
      config,
      {
        alertPort: env.EARTHQUAKE_ALERT_PORT,
        alertKey: env.EARTHQUAKE_ALERT_KEY,
        cwaApiKey: env.CWA_API_KEY,
      },
      env.MONGO_INSPECT_URI,
    ),
});
