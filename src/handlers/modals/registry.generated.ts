// AUTO-GENERATED — do not edit. Source: scripts/gen-registry.ts
// Run `npm run handlers:gen` after adding, renaming, or removing a handler
// subdirectory; CI verifies this file matches the on-disk layout via
// `npm run handlers:gen:check`.

import type { ModalHandler } from '.';
import { default as Handler_0 } from './ai_settings';
import { default as Handler_1 } from './giveaway_create';
export const MODAL_REGISTRY = {
  ai_settings: Handler_0,
  giveaway_create: Handler_1,
} as const satisfies Readonly<Record<string, new () => ModalHandler>>;
