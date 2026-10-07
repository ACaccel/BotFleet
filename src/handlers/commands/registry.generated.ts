// AUTO-GENERATED — do not edit. Source: scripts/gen-registry.ts
// Run `npm run handlers:gen` after adding, renaming, or removing a handler
// subdirectory; CI verifies this file matches the on-disk layout via
// `npm run handlers:gen:check`.

import type { Command } from '.';
import { default as Handler_0 } from './activity_create';
import { default as Handler_1 } from './activity_delete';
import { default as Handler_2 } from './add_reply';
import { default as Handler_3 } from './ai_settings';
import { default as Handler_4 } from './ai_status';
import { default as Handler_5 } from './ai_whitelist_add';
import { default as Handler_6 } from './ai_whitelist_list';
import { default as Handler_7 } from './ai_whitelist_remove';
import { default as Handler_8 } from './ban_user';
import { default as Handler_9 } from './bubble_wrap';
import { default as Handler_10 } from './bug_report';
import { default as Handler_11 } from './change_avatar';
import { default as Handler_12 } from './change_nickname';
import { default as Handler_13 } from './db_list_message';
import { default as Handler_14 } from './delete_reply';
import { default as Handler_15 } from './emoji_frequency';
import { default as Handler_16 } from './feed_list';
import { default as Handler_17 } from './feed_subscribe';
import { default as Handler_18 } from './feed_unsubscribe';
import { default as Handler_19 } from './gay';
import { default as Handler_20 } from './get_avatar';
import { default as Handler_21 } from './give_score';
import { default as Handler_22 } from './giveaway_create';
import { default as Handler_23 } from './giveaway_delete';
import { default as Handler_24 } from './help';
import { default as Handler_25 } from './level_detail';
import { default as Handler_26 } from './list_guild_members';
import { default as Handler_27 } from './list_reply';
import { default as Handler_28 } from './menu_get_avatar';
import { default as Handler_29 } from './menu_get_sticker';
import { default as Handler_30 } from './random_restaurant';
import { default as Handler_31 } from './role_message';
import { default as Handler_32 } from './roll_call';
import { default as Handler_33 } from './search_anime_scene';
import { default as Handler_34 } from './sticker_frequency';
import { default as Handler_35 } from './talk';
import { default as Handler_36 } from './talk_signed';
import { default as Handler_37 } from './temp_role';
import { default as Handler_38 } from './thread_allow';
import { default as Handler_39 } from './thread_ban';
import { default as Handler_40 } from './thread_claim';
import { default as Handler_41 } from './thread_list';
import { default as Handler_42 } from './thread_manager';
import { default as Handler_43 } from './traffic';
import { default as Handler_44 } from './traffic_me';
import { default as Handler_45 } from './traffic_user';
import { default as Handler_46 } from './update_role';
import { default as Handler_47 } from './weather_forecast';
export const COMMAND_REGISTRY = {
  activity_create: Handler_0,
  activity_delete: Handler_1,
  add_reply: Handler_2,
  ai_settings: Handler_3,
  ai_status: Handler_4,
  ai_whitelist_add: Handler_5,
  ai_whitelist_list: Handler_6,
  ai_whitelist_remove: Handler_7,
  ban_user: Handler_8,
  bubble_wrap: Handler_9,
  bug_report: Handler_10,
  change_avatar: Handler_11,
  change_nickname: Handler_12,
  db_list_message: Handler_13,
  delete_reply: Handler_14,
  emoji_frequency: Handler_15,
  feed_list: Handler_16,
  feed_subscribe: Handler_17,
  feed_unsubscribe: Handler_18,
  gay: Handler_19,
  get_avatar: Handler_20,
  give_score: Handler_21,
  giveaway_create: Handler_22,
  giveaway_delete: Handler_23,
  help: Handler_24,
  level_detail: Handler_25,
  list_guild_members: Handler_26,
  list_reply: Handler_27,
  menu_get_avatar: Handler_28,
  menu_get_sticker: Handler_29,
  random_restaurant: Handler_30,
  role_message: Handler_31,
  roll_call: Handler_32,
  search_anime_scene: Handler_33,
  sticker_frequency: Handler_34,
  talk: Handler_35,
  talk_signed: Handler_36,
  temp_role: Handler_37,
  thread_allow: Handler_38,
  thread_ban: Handler_39,
  thread_claim: Handler_40,
  thread_list: Handler_41,
  thread_manager: Handler_42,
  traffic: Handler_43,
  traffic_me: Handler_44,
  traffic_user: Handler_45,
  update_role: Handler_46,
  weather_forecast: Handler_47,
} as const satisfies Readonly<Record<string, new () => Command>>;
