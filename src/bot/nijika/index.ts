import { Nijika } from './nijika';
import config from './config.json';

import { bootstrapPersonality, DM_PARTIALS, GUILD_OBSERVER_INTENTS } from '../bootstrap';

// `requirePort` makes env validation fail fast when `PORT` is absent —
// nijika cannot run without it because the earthquake webhook plugin
// needs a listening port. The webhook server itself is owned by the
// `earthquake` plugin's `start` hook (see `Nijika`'s composition in
// `nijika.ts`).
bootstrapPersonality({
  name: 'nijika',
  intents: GUILD_OBSERVER_INTENTS,
  // `/bug_report` replies reach the bot as DMs.
  partials: DM_PARTIALS,
  env: { requirePort: true },
  // `requirePort` above guarantees `env.PORT` is defined; the assertion
  // documents that invariant for the type checker.
  // `CWA_API_KEY` is optional: without it the earthquake plugin runs the
  // webhook alone and skips CWA report polling. `MONGO_INSPECT_URI` is
  // checked by `Nijika` only when `config.commands` lists `db`.
  build: (client, env) =>
    new Nijika(
      client,
      env.TOKEN,
      env.MONGO_URI ?? '',
      env.CLIENT_ID,
      config,
      env.PORT as number,
      env.CWA_API_KEY,
      env.MONGO_INSPECT_URI,
    ),
});
