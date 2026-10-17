// AUTO-GENERATED — do not edit. Source: scripts/gen-registry.ts
// Run `npm run handlers:gen` after adding, renaming, or removing a handler
// subdirectory; CI verifies this file matches the on-disk layout via
// `npm run handlers:gen:check`.

import type { SSMHandler } from '.';
import { default as Handler_0 } from './bug_ticket_pick';
import { default as Handler_1 } from './db_view';
import { default as Handler_2 } from './delete_reply';
import { default as Handler_3 } from './feed_panel';
import { default as Handler_4 } from './giveaway_delete';
import { default as Handler_5 } from './help_category';
import { default as Handler_6 } from './settings';
export const SSM_REGISTRY = {
  bug_ticket_pick: Handler_0,
  db_view: Handler_1,
  delete_reply: Handler_2,
  feed_panel: Handler_3,
  giveaway_delete: Handler_4,
  help_category: Handler_5,
  settings: Handler_6,
} as const satisfies Readonly<Record<string, new () => SSMHandler>>;
