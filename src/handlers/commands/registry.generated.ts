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
import { default as Handler_6 } from './feed';
import { default as Handler_7 } from './gay';
import { default as Handler_8 } from './give_score';
import { default as Handler_9 } from './giveaway';
import { default as Handler_10 } from './help';
import { default as Handler_11 } from './level_detail';
import { default as Handler_12 } from './menu_get_avatar';
import { default as Handler_13 } from './menu_get_sticker';
import { default as Handler_14 } from './random_restaurant';
import { default as Handler_15 } from './reply';
import { default as Handler_16 } from './role_message';
import { default as Handler_17 } from './roll_call';
import { default as Handler_18 } from './talk';
import { default as Handler_19 } from './talk_signed';
import { default as Handler_20 } from './temp_role';
import { default as Handler_21 } from './thread';
import { default as Handler_22 } from './traffic';
import { default as Handler_23 } from './update_role';
export const COMMAND_REGISTRY = {
  activity: Handler_0,
  ai: Handler_1,
  archive: Handler_2,
  ban_user: Handler_3,
  bug_report: Handler_4,
  change_avatar: Handler_5,
  feed: Handler_6,
  gay: Handler_7,
  give_score: Handler_8,
  giveaway: Handler_9,
  help: Handler_10,
  level_detail: Handler_11,
  menu_get_avatar: Handler_12,
  menu_get_sticker: Handler_13,
  random_restaurant: Handler_14,
  reply: Handler_15,
  role_message: Handler_16,
  roll_call: Handler_17,
  talk: Handler_18,
  talk_signed: Handler_19,
  temp_role: Handler_20,
  thread: Handler_21,
  traffic: Handler_22,
  update_role: Handler_23,
} as const satisfies Readonly<Record<string, new () => Command>>;
