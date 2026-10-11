// AUTO-GENERATED — do not edit. Source: scripts/gen-registry.ts
// Run `npm run handlers:gen` after adding, renaming, or removing a handler
// subdirectory; CI verifies this file matches the on-disk layout via
// `npm run handlers:gen:check`.

import type { Command } from '.';
import { default as Handler_0 } from './activity';
import { default as Handler_1 } from './ai';
import { default as Handler_2 } from './archive';
import { default as Handler_3 } from './ban_user';
import { default as Handler_4 } from './bubble_wrap';
import { default as Handler_5 } from './bug_report';
import { default as Handler_6 } from './change_avatar';
import { default as Handler_7 } from './change_nickname';
import { default as Handler_8 } from './feed';
import { default as Handler_9 } from './gay';
import { default as Handler_10 } from './get_avatar';
import { default as Handler_11 } from './give_score';
import { default as Handler_12 } from './giveaway';
import { default as Handler_13 } from './help';
import { default as Handler_14 } from './level_detail';
import { default as Handler_15 } from './list_guild_members';
import { default as Handler_16 } from './menu_get_avatar';
import { default as Handler_17 } from './menu_get_sticker';
import { default as Handler_18 } from './random_restaurant';
import { default as Handler_19 } from './reply';
import { default as Handler_20 } from './role_message';
import { default as Handler_21 } from './roll_call';
import { default as Handler_22 } from './search_anime_scene';
import { default as Handler_23 } from './talk';
import { default as Handler_24 } from './talk_signed';
import { default as Handler_25 } from './temp_role';
import { default as Handler_26 } from './thread';
import { default as Handler_27 } from './traffic';
import { default as Handler_28 } from './update_role';
import { default as Handler_29 } from './weather_forecast';
export const COMMAND_REGISTRY = {
  activity: Handler_0,
  ai: Handler_1,
  archive: Handler_2,
  ban_user: Handler_3,
  bubble_wrap: Handler_4,
  bug_report: Handler_5,
  change_avatar: Handler_6,
  change_nickname: Handler_7,
  feed: Handler_8,
  gay: Handler_9,
  get_avatar: Handler_10,
  give_score: Handler_11,
  giveaway: Handler_12,
  help: Handler_13,
  level_detail: Handler_14,
  list_guild_members: Handler_15,
  menu_get_avatar: Handler_16,
  menu_get_sticker: Handler_17,
  random_restaurant: Handler_18,
  reply: Handler_19,
  role_message: Handler_20,
  roll_call: Handler_21,
  search_anime_scene: Handler_22,
  talk: Handler_23,
  talk_signed: Handler_24,
  temp_role: Handler_25,
  thread: Handler_26,
  traffic: Handler_27,
  update_role: Handler_28,
  weather_forecast: Handler_29,
} as const satisfies Readonly<Record<string, new () => Command>>;
