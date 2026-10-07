// AUTO-GENERATED — do not edit. Source: scripts/gen-registry.ts
// Run `npm run handlers:gen` after adding, renaming, or removing a handler
// subdirectory; CI verifies this file matches the on-disk layout via
// `npm run handlers:gen:check`.

import type { SSMHandler } from '.';
import { default as Handler_0 } from './archive_actions';
import { default as Handler_1 } from './archive_category';
import { default as Handler_2 } from './archive_pick';
import { default as Handler_3 } from './delete_reply';
import { default as Handler_4 } from './giveaway_delete';
export const SSM_REGISTRY = {
  archive_actions: Handler_0,
  archive_category: Handler_1,
  archive_pick: Handler_2,
  delete_reply: Handler_3,
  giveaway_delete: Handler_4,
} as const satisfies Readonly<Record<string, new () => SSMHandler>>;
