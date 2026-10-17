// AUTO-GENERATED — do not edit. Source: scripts/gen-registry.ts
// Run `npm run handlers:gen` after adding, renaming, or removing a handler
// subdirectory; CI verifies this file matches the on-disk layout via
// `npm run handlers:gen:check`.

import type { ModalHandler } from '.';
import { default as Handler_0 } from './activity_create';
import { default as Handler_1 } from './ai_settings';
import { default as Handler_2 } from './bug_report';
import { default as Handler_3 } from './feed_panel';
import { default as Handler_4 } from './gallery_page';
import { default as Handler_5 } from './giveaway_create';
import { default as Handler_6 } from './settings';
export const MODAL_REGISTRY = {
  activity_create: Handler_0,
  ai_settings: Handler_1,
  bug_report: Handler_2,
  feed_panel: Handler_3,
  gallery_page: Handler_4,
  giveaway_create: Handler_5,
  settings: Handler_6,
} as const satisfies Readonly<Record<string, new () => ModalHandler>>;
