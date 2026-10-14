// AUTO-GENERATED — do not edit. Source: scripts/gen-registry.ts
// Run `npm run handlers:gen` after adding, renaming, or removing a handler
// subdirectory; CI verifies this file matches the on-disk layout via
// `npm run handlers:gen:check`.

import type { ButtonHandler } from '.';
import { default as Handler_0 } from './activity';
import { default as Handler_1 } from './archive';
import { default as Handler_2 } from './bug_ticket';
import { default as Handler_3 } from './feed_clear_cancel';
import { default as Handler_4 } from './feed_clear_confirm';
import { default as Handler_5 } from './level_page';
import { default as Handler_6 } from './roll_call';
import { default as Handler_7 } from './thread_claim';
import { default as Handler_8 } from './thread_list';
import { default as Handler_9 } from './toggle_role';
export const BUTTON_REGISTRY = {
  activity: Handler_0,
  archive: Handler_1,
  bug_ticket: Handler_2,
  feed_clear_cancel: Handler_3,
  feed_clear_confirm: Handler_4,
  level_page: Handler_5,
  roll_call: Handler_6,
  thread_claim: Handler_7,
  thread_list: Handler_8,
  toggle_role: Handler_9,
} as const satisfies Readonly<Record<string, new () => ButtonHandler>>;
