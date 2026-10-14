// AUTO-GENERATED — do not edit. Source: scripts/gen-registry.ts
// Run `npm run handlers:gen` after adding, renaming, or removing a handler
// subdirectory; CI verifies this file matches the on-disk layout via
// `npm run handlers:gen:check`.

import type { SSMHandler } from '.';
import { default as Handler_0 } from './bug_ticket_pick';
import { default as Handler_1 } from './db_view';
import { default as Handler_2 } from './delete_reply';
import { default as Handler_3 } from './giveaway_delete';
import { default as Handler_4 } from './help_category';
export const SSM_REGISTRY = {
  bug_ticket_pick: Handler_0,
  db_view: Handler_1,
  delete_reply: Handler_2,
  giveaway_delete: Handler_3,
  help_category: Handler_4,
} as const satisfies Readonly<Record<string, new () => SSMHandler>>;
