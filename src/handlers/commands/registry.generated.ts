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
import { default as Handler_8 } from './db_list_message';
import { default as Handler_9 } from './emoji_frequency';
import { default as Handler_10 } from './feed';
import { default as Handler_11 } from './gay';
import { default as Handler_12 } from './get_avatar';
import { default as Handler_13 } from './give_score';
import { default as Handler_14 } from './giveaway';
import { default as Handler_15 } from './help';
import { default as Handler_16 } from './level_detail';
import { default as Handler_17 } from './list_guild_members';
import { default as Handler_18 } from './menu_get_avatar';
import { default as Handler_19 } from './menu_get_sticker';
import { default as Handler_20 } from './random_restaurant';
import { default as Handler_21 } from './reply';
import { default as Handler_22 } from './role_message';
import { default as Handler_23 } from './roll_call';
import { default as Handler_24 } from './search_anime_scene';
import { default as Handler_25 } from './sticker_frequency';
import { default as Handler_26 } from './talk';
import { default as Handler_27 } from './talk_signed';
import { default as Handler_28 } from './temp_role';
import { default as Handler_29 } from './thread';
import { default as Handler_30 } from './traffic';
import { default as Handler_31 } from './update_role';
import { default as Handler_32 } from './weather_forecast';
export const COMMAND_REGISTRY = {
  activity: Handler_0,
  ai: Handler_1,
  archive: Handler_2,
  ban_user: Handler_3,
  bubble_wrap: Handler_4,
  bug_report: Handler_5,
  change_avatar: Handler_6,
  change_nickname: Handler_7,
  db_list_message: Handler_8,
  emoji_frequency: Handler_9,
  feed: Handler_10,
  gay: Handler_11,
  get_avatar: Handler_12,
  give_score: Handler_13,
  giveaway: Handler_14,
  help: Handler_15,
  level_detail: Handler_16,
  list_guild_members: Handler_17,
  menu_get_avatar: Handler_18,
  menu_get_sticker: Handler_19,
  random_restaurant: Handler_20,
  reply: Handler_21,
  role_message: Handler_22,
  roll_call: Handler_23,
  search_anime_scene: Handler_24,
  sticker_frequency: Handler_25,
  talk: Handler_26,
  talk_signed: Handler_27,
  temp_role: Handler_28,
  thread: Handler_29,
  traffic: Handler_30,
  update_role: Handler_31,
  weather_forecast: Handler_32,
} as const satisfies Readonly<Record<string, new () => Command>>;
