/**
 * String select menu handler contract.
 *
 * Split out of `select-menus/index.ts` so it carries no dependency on
 * the generated handler registry. See `buttons/button-handler.ts` for
 * the rationale behind the split.
 */
import {
  ComponentType,
  type ChannelSelectMenuInteraction,
  type RoleSelectMenuInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { BaseBot } from '@bot';

export type SelectMenuInteraction =
  | StringSelectMenuInteraction
  | RoleSelectMenuInteraction
  | ChannelSelectMenuInteraction;

export abstract class SSMHandler<T extends SelectMenuInteraction = StringSelectMenuInteraction> {
  public readonly componentTypes: readonly ComponentType[] = [ComponentType.StringSelect];
  public abstract execute(interaction: T, bot: BaseBot): Promise<void>;
}
