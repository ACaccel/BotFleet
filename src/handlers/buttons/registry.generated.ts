// AUTO-GENERATED — do not edit. Source: scripts/gen-registry.ts
// Run `npm run handlers:gen` after adding, renaming, or removing a handler
// subdirectory; CI verifies this file matches the on-disk layout via
// `npm run handlers:gen:check`.

import type { ButtonHandler } from '.';
import { default as Handler_0 } from './archive';
import { default as Handler_1 } from './archive_browse';
import { default as Handler_2 } from './archive_confirm';
import { default as Handler_3 } from './archive_jobs';
import { default as Handler_4 } from './archive_manage';
import { default as Handler_5 } from './archive_panel';
import { default as Handler_6 } from './archive_view';
import { default as Handler_7 } from './feed_clear_cancel';
import { default as Handler_8 } from './feed_clear_confirm';
import { default as Handler_9 } from './thread_claim';
import { default as Handler_10 } from './thread_list';
import { default as Handler_11 } from './toggle_role';
export const BUTTON_REGISTRY = {
  archive: Handler_0,
  archive_browse: Handler_1,
  archive_confirm: Handler_2,
  archive_jobs: Handler_3,
  archive_manage: Handler_4,
  archive_panel: Handler_5,
  archive_view: Handler_6,
  feed_clear_cancel: Handler_7,
  feed_clear_confirm: Handler_8,
  thread_claim: Handler_9,
  thread_list: Handler_10,
  toggle_role: Handler_11,
} as const satisfies Readonly<Record<string, new () => ButtonHandler>>;
