// AUTO-GENERATED — do not edit. Source: scripts/gen-registry.ts
// Run `npm run handlers:gen` after adding, renaming, or removing a handler
// subdirectory; CI verifies this file matches the on-disk layout via
// `npm run handlers:gen:check`.

import type { Command } from '.';
import { default as Handler_0 } from './activity';
import { default as Handler_1 } from './ai';
import { default as Handler_2 } from './archive';
import { default as Handler_3 } from './ban_user';
import { default as Handler_4 } from './bug_report';
import { default as Handler_5 } from './change_avatar';
import { default as Handler_6 } from './db';
import { default as Handler_7 } from './feed';
import { default as Handler_8 } from './gay';
import { default as Handler_9 } from './give_score';
import { default as Handler_10 } from './giveaway';
import { default as Handler_11 } from './help';
import { default as Handler_12 } from './level_detail';
import { default as Handler_13 } from './menu_author_avatar';
import { default as Handler_14 } from './menu_get_avatar';
import { default as Handler_15 } from './menu_get_sticker';
import { default as Handler_16 } from './menu_give_score';
import { default as Handler_17 } from './random_restaurant';
import { default as Handler_18 } from './reply';
import { default as Handler_19 } from './role';
import { default as Handler_20 } from './roll_call';
import { default as Handler_21 } from './talk';
import { default as Handler_22 } from './thread';
import { default as Handler_23 } from './traffic';
export const COMMAND_REGISTRY = {
  activity: Handler_0,
  ai: Handler_1,
  archive: Handler_2,
  ban_user: Handler_3,
  bug_report: Handler_4,
  change_avatar: Handler_5,
  db: Handler_6,
  feed: Handler_7,
  gay: Handler_8,
  give_score: Handler_9,
  giveaway: Handler_10,
  help: Handler_11,
  level_detail: Handler_12,
  menu_author_avatar: Handler_13,
  menu_get_avatar: Handler_14,
  menu_get_sticker: Handler_15,
  menu_give_score: Handler_16,
  random_restaurant: Handler_17,
  reply: Handler_18,
  role: Handler_19,
  roll_call: Handler_20,
  talk: Handler_21,
  thread: Handler_22,
  traffic: Handler_23,
} as const satisfies Readonly<Record<string, new () => Command>>;
