// AUTO-GENERATED — do not edit. Source: scripts/gen-registry.ts
// Run `npm run handlers:gen` after adding, renaming, or removing a handler
// subdirectory; CI verifies this file matches the on-disk layout via
// `npm run handlers:gen:check`.

import type { ButtonHandler } from '.';
import { default as Handler_0 } from './archive';
import { default as Handler_1 } from './feed_clear_cancel';
import { default as Handler_2 } from './feed_clear_confirm';
import { default as Handler_3 } from './thread_claim';
import { default as Handler_4 } from './thread_list';
import { default as Handler_5 } from './toggle_role';
export const BUTTON_REGISTRY = {
  archive: Handler_0,
  feed_clear_cancel: Handler_1,
  feed_clear_confirm: Handler_2,
  thread_claim: Handler_3,
  thread_list: Handler_4,
  toggle_role: Handler_5,
} as const satisfies Readonly<Record<string, new () => ButtonHandler>>;
