/**
 * What `/help` knows about a command: every executable path with its
 * catalog keys, read from the raw command metadata so display-only flags
 * such as `adminOnly` survive (localisation drops them).
 *
 * Imports come from `../command` rather than the `@cmd` barrel, which
 * would pull in the generated registry that registers `/help` itself.
 */
import type { Command, CommandCategory, CommandConfig } from '../command';

/** Render order for category sections; `'other'` collects the rest. */
export const CATEGORY_ORDER: readonly CommandCategory[] = [
  'fun',
  'auto_reply',
  'server_activity',
  'utility',
  'admin',
  'ai',
  'other',
];

interface HelpOption {
  readonly name: string;
  readonly required: boolean;
  readonly descriptionKey: string;
}

export interface HelpPath {
  /** As typed, for example `/thread manager add`; a context menu's key names it. */
  readonly label: string;
  readonly descriptionKey: string;
  readonly adminOnly: boolean;
  readonly options: readonly HelpOption[];
}

const optionsOf = (options: CommandConfig['options'], prefix: string): HelpOption[] =>
  Object.values(options ?? {})
    .flat()
    .map((option) => ({
      name: option.name,
      required: option.required,
      descriptionKey: `${prefix}.options.${option.name}.description`,
    }))
    .sort((a, b) => Number(b.required) - Number(a.required));

/** Every path of `command`; a plain command is its own single path. */
export const helpPaths = (command: Command): HelpPath[] => {
  const { config } = command;
  const prefix = `commands:${config.name}`;
  if (config.type !== undefined) {
    return [{ label: `${prefix}.name`, descriptionKey: '', adminOnly: false, options: [] }];
  }
  const paths: HelpPath[] = (config.subcommands ?? []).map((sub) => ({
    label: `/${config.name} ${sub.name}`,
    descriptionKey: `${prefix}.subcommands.${sub.name}.description`,
    adminOnly: sub.adminOnly === true,
    options: optionsOf(sub.options, `${prefix}.subcommands.${sub.name}`),
  }));
  for (const group of config.subcommandGroups ?? []) {
    for (const sub of group.subcommands) {
      const subPrefix = `${prefix}.groups.${group.name}.subcommands.${sub.name}`;
      paths.push({
        label: `/${config.name} ${group.name} ${sub.name}`,
        descriptionKey: `${subPrefix}.description`,
        adminOnly: group.adminOnly === true || sub.adminOnly === true,
        options: optionsOf(sub.options, subPrefix),
      });
    }
  }
  if (paths.length > 0) return paths;
  return [
    {
      label: `/${config.name}`,
      descriptionKey: `${prefix}.description`,
      adminOnly: false,
      options: optionsOf(config.options, prefix),
    },
  ];
};

/** The bot's loaded commands grouped by category, in render order. */
export const commandsByCategory = (
  handlers: ReadonlyMap<string, Command>,
): Map<CommandCategory, Command[]> => {
  const grouped = new Map<CommandCategory, Command[]>(CATEGORY_ORDER.map((c) => [c, []]));
  for (const command of handlers.values()) {
    if (command.config.name.length === 0) continue;
    grouped.get(command.config.category ?? 'other')?.push(command);
  }
  for (const [category, commands] of grouped) if (commands.length === 0) grouped.delete(category);
  return grouped;
};
