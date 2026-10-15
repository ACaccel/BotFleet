// AUTO-GENERATED — do not edit. Source: scripts/gen-registry.ts
// Run `npm run handlers:gen` after adding, renaming, or removing a handler
// subdirectory; CI verifies this file matches the on-disk layout via
// `npm run handlers:gen:check`.

import type { ButtonHandler } from '.';
import { default as Handler_0 } from './activity';
import { default as Handler_1 } from './archive';
import { default as Handler_2 } from './bug_ticket';
import { default as Handler_3 } from './db_page';
import { default as Handler_4 } from './feed_clear_cancel';
import { default as Handler_5 } from './feed_clear_confirm';
import { default as Handler_6 } from './level_page';
import { default as Handler_7 } from './roll_call';
import { default as Handler_8 } from './settings';
import { default as Handler_9 } from './thread_claim';
import { default as Handler_10 } from './thread_list';
import { default as Handler_11 } from './toggle_role';
export const BUTTON_REGISTRY = {
  activity: Handler_0,
  archive: Handler_1,
  bug_ticket: Handler_2,
  db_page: Handler_3,
  feed_clear_cancel: Handler_4,
  feed_clear_confirm: Handler_5,
  level_page: Handler_6,
  roll_call: Handler_7,
  settings: Handler_8,
  thread_claim: Handler_9,
  thread_list: Handler_10,
  toggle_role: Handler_11,
} as const satisfies Readonly<Record<string, new () => ButtonHandler>>;
