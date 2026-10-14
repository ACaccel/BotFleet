// AUTO-GENERATED — do not edit. Source: scripts/gen-registry.ts
// Run `npm run handlers:gen` after adding, renaming, or removing a handler
// subdirectory; CI verifies this file matches the on-disk layout via
// `npm run handlers:gen:check`.

import type { SSMHandler } from '.';
import { default as Handler_0 } from './bug_ticket_pick';
import { default as Handler_1 } from './delete_reply';
import { default as Handler_2 } from './giveaway_delete';
import { default as Handler_3 } from './help_category';
export const SSM_REGISTRY = {
  bug_ticket_pick: Handler_0,
  delete_reply: Handler_1,
  giveaway_delete: Handler_2,
  help_category: Handler_3,
} as const satisfies Readonly<Record<string, new () => SSMHandler>>;
