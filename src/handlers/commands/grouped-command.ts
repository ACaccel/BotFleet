import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import type { BaseBot } from '@bot';
import { Command, type CommandConfig } from './command';
import { replyTranslated } from '../reply-translated';

interface CommandRoute {
  readonly group?: string;
  readonly name: string;
  readonly command: Command;
  /** Hide the path from non-admins in `/help`; the action still authorizes. */
  readonly adminOnly?: boolean;
}

interface GroupedCommandConfig {
  readonly name: string;
  readonly category: CommandConfig['category'];
  readonly guildOnly?: boolean;
  readonly routes: readonly CommandRoute[];
}

/** Compose existing actions without broadening their runtime authorization. */
export class GroupedCommand extends Command {
  private readonly routes: readonly CommandRoute[];

  constructor({ routes, ...config }: GroupedCommandConfig) {
    super();
    this.routes = routes;
    const subcommands: NonNullable<CommandConfig['subcommands']> = [];
    const groups: NonNullable<CommandConfig['subcommandGroups']> = [];
    const seen = new Set<string>();
    for (const route of routes) {
      const key = `${route.group ?? ''}/${route.name}`;
      if (seen.has(key)) throw new TypeError(`Duplicate command route: ${config.name}/${key}`);
      seen.add(key);
      const child = route.command.config;
      const options = child.subcommands
        ? child.subcommands.find((entry) => entry.name === route.name)?.options
        : child.options;
      if (child.subcommands && !child.subcommands.some((entry) => entry.name === route.name)) {
        throw new TypeError(`Unknown child subcommand: ${child.name}/${route.name}`);
      }
      const subcommand = {
        name: route.name,
        ...(options ? { options } : {}),
        ...(route.adminOnly === true ? { adminOnly: true } : {}),
      };
      if (route.group === undefined) subcommands.push(subcommand);
      else {
        let group = groups.find((entry) => entry.name === route.group);
        if (!group) {
          group = { name: route.group, subcommands: [] };
          groups.push(group);
        }
        group.subcommands.push(subcommand);
      }
    }
    this.setConfig({
      ...config,
      ...(subcommands.length ? { subcommands } : {}),
      ...(groups.length ? { subcommandGroups: groups } : {}),
    });
    if (routes.some((route) => route.command.autocomplete !== undefined)) {
      this.autocomplete = async (interaction, bot) =>
        (await this.resolve(interaction)?.autocomplete?.(interaction, bot)) ?? [];
    }
  }

  private resolve(
    interaction: ChatInputCommandInteraction | AutocompleteInteraction,
  ): Command | undefined {
    const group = interaction.options.getSubcommandGroup(false) ?? undefined;
    const name = interaction.options.getSubcommand(false);
    return this.routes.find((route) => route.group === group && route.name === name)?.command;
  }

  public override validateBotConfig(config: unknown): void {
    for (const command of new Set(this.routes.map((route) => route.command))) {
      command.validateBotConfig?.(config);
    }
  }

  public override async execute(
    interaction: ChatInputCommandInteraction,
    bot: BaseBot,
  ): Promise<void> {
    const command = this.resolve(interaction);
    if (!command) {
      await replyTranslated(interaction, bot.translator, 'errors:command.not_found', {
        name: this.config.name,
      });
      return;
    }
    await command.execute(interaction, bot);
  }
}
