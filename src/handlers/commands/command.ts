/**
 * Command metadata contract and i18n resolution.
 *
 * Split out of `commands/index.ts` so it carries no dependency on the
 * generated handler registry — handler subclasses, the deploy CLI, and
 * unit tests can import `Command` / `CommandConfig` / `localizeCommandConfig`
 * without dragging in every handler module (which `index.ts` does via
 * `registry.generated.ts`).
 */
import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  ContextMenuCommandInteraction,
  ContextMenuCommandType,
} from 'discord.js';
import type { BaseBot } from '@bot';

import type { Translator } from '../../core/i18n';

/**
 * Self-describing slash-command metadata.
 *
 * `description` (and `CommandOption.description`) are not stored inline:
 * a handler's `setConfig` omits them entirely, and
 * {@link localizeCommandConfig} fills them from the `commands` i18n
 * namespace, deriving the catalog key from {@link CommandConfig.name}.
 * Context-menu commands take their localised `name` from
 * `commands:<name>.name`.
 *
 * The optional `description` therefore models the *pre-localisation*
 * shape stored by handlers; consumers that build the Discord command
 * JSON (`getCommandJsonBody`, `register.ts`) run the config through
 * `localizeCommandConfig` first so `description` is defined.
 */
/**
 * Grouping key used by `/help` to render commands under a labelled
 * section. Stable ASCII ids (the display label is resolved from
 * `replies:help.category.<key>`), so this stays CJK-free. A command
 * that omits `category` falls into `'other'`.
 */
export type CommandCategory =
  | 'auto_reply'
  | 'fun'
  | 'server_activity'
  | 'utility'
  | 'admin'
  | 'ai'
  | 'other';

export interface CommandConfig {
  name: string; // command name for handler lookup and Discord registration
  /** Resolved from `commands:<name>.description`; omitted by handlers. */
  description?: string;
  type?: ContextMenuCommandType; // for context menu commands, default is Chat Input
  /** `/help` grouping key; defaults to `'other'` when a handler omits it. */
  category?: CommandCategory;
  options?: {
    string?: CommandOption[];
    number?: CommandOption[];
    float?: CommandOption[];
    user?: CommandOption[];
    channel?: CommandOption[];
    attachment?: CommandOption[];
  };
}

export interface CommandOption {
  name: string;
  /** Resolved from `commands:<cmd>.options.<name>.description`. */
  description?: string;
  required: boolean;
  choices?: CommandChoice[];
  /**
   * Have Discord query the handler's {@link Command.autocomplete} hook
   * as the member types, instead of offering a fixed list.
   *
   * **String options only**, and **mutually exclusive with `choices`** —
   * Discord rejects an option carrying both. `buildCommandJsonBody`
   * fails on either misuse rather than letting it reach the REST call.
   */
  autocomplete?: boolean;
  /** Minimum numeric value (only applies to `number` and `float` options). */
  min?: number;
  /** Maximum numeric value (only applies to `number` and `float` options). */
  max?: number;
}

interface CommandChoice {
  /**
   * Display label. Optional in the pre-localisation shape: a handler
   * may omit it and let {@link localizeCommandConfig} fill it from
   * `commands:<cmd>.options.<opt>.choices.<value>`. Handlers whose
   * choice list is sourced from a colocated data file (e.g.
   * `change_avatar`, `random_restaurant`) set it directly.
   */
  name?: string;
  value: string;
}

/**
 * A {@link CommandConfig} whose i18n-keyed metadata has been resolved
 * to concrete display strings by {@link localizeCommandConfig}. The
 * Discord command-JSON builder consumes this stricter shape so the
 * `description` fields are statically known to be present.
 */
export interface LocalizedCommandConfig extends CommandConfig {
  description: string;
  options?: {
    string?: LocalizedCommandOption[];
    number?: LocalizedCommandOption[];
    float?: LocalizedCommandOption[];
    user?: LocalizedCommandOption[];
    channel?: LocalizedCommandOption[];
    attachment?: LocalizedCommandOption[];
  };
}

/** A {@link CommandOption} with its description and choices resolved. */
export interface LocalizedCommandOption extends CommandOption {
  description: string;
  choices?: LocalizedCommandChoice[];
}

/** A {@link CommandChoice} with its display label resolved. */
export interface LocalizedCommandChoice extends CommandChoice {
  name: string;
}

/**
 * What a {@link Command.autocomplete} hook hands back: the suggestions
 * Discord should offer, best first.
 *
 * The hook returns them rather than sending them, so a handler never
 * touches `AutocompleteInteraction.respond`. Discord's limits (25
 * choices, 100 characters per name and per value) and the 3-second
 * window are the dispatcher's problem, and centralising them there is
 * what keeps a hook from being able to fail the interaction.
 *
 * Deliberately narrower than discord.js's `ApplicationCommandOptionChoiceData`:
 * `value` is `string` because the flag only applies to string options,
 * and `nameLocalizations` is absent because Discord applies the same
 * 100-character ceiling to every localised name — a field the
 * dispatcher would have to bound too, and one a suggestion built from
 * stored data has no use for.
 */
export type CommandSuggestions = readonly {
  readonly name: string;
  readonly value: string;
}[];

/**
 * Abstract base for every slash-command / context-menu handler.
 *
 * Command pattern: each concrete handler is a self-describing command
 * object the dispatcher invokes polymorphically through `execute`.
 */
export abstract class Command {
  public config: CommandConfig;

  public constructor() {
    this.config = { name: '' };
  }

  public setConfig(config: CommandConfig): void {
    this.config = config;
  }

  /**
   * Optional startup validation of the operator's `config.json`.
   *
   * A handler that needs a per-bot configuration block (an upstream
   * endpoint, a location id) implements this and throws when the
   * block is missing or malformed. `registerCommands` calls it once
   * per enabled command, logs the failure with its cause, and skips
   * registering that command — so a misconfiguration surfaces in the
   * boot log rather than as a puzzling reply the first time someone
   * runs the command.
   *
   * @param botConfig - the personality's parsed `config.json`.
   * @throws when the required configuration is absent or invalid.
   */
  public validateBotConfig?(botConfig: unknown): void;

  /**
   * Suggestions for the option the member is currently typing into.
   *
   * Implemented by a handler that marks one of its string options
   * `autocomplete: true`; the dispatcher routes the interaction here,
   * bounds the result to Discord's limits and answers with it. A
   * command without this hook — or one whose hook throws — offers an
   * empty list, because an autocomplete interaction cannot be replied
   * to and so has no way to report a failure to the member.
   *
   * Read the focused option with `interaction.options.getFocused()` and
   * the sibling options with the accessors in `infra/discord/options`;
   * the latter are the values as typed so far, and any of them may
   * still be absent.
   *
   * Answer fast. Discord discards a response that arrives more than
   * three seconds after the keystroke, so a hook belongs on a database
   * read or a cache, never on an upstream call.
   */
  public autocomplete?(
    interaction: AutocompleteInteraction,
    bot: BaseBot,
  ): Promise<CommandSuggestions>;

  public abstract execute(
    interaction: ChatInputCommandInteraction | ContextMenuCommandInteraction,
    bot: BaseBot,
  ): Promise<void>;
}

/**
 * Resolve a {@link CommandConfig}'s i18n-keyed metadata into a config
 * carrying concrete display strings.
 *
 * Catalog keys are derived from the command / option names:
 *   - command description -> `commands:<name>.description`
 *   - context-menu display name -> `commands:<name>.name`
 *   - option description -> `commands:<name>.options.<opt>.description`
 *   - choice label -> `commands:<name>.options.<opt>.choices.<value>`
 *
 * Resolution happens against the translator's default locale. Returns
 * a shallow copy; the input is not mutated.
 */
export const localizeCommandConfig = (
  config: CommandConfig,
  translator: Translator | undefined,
): LocalizedCommandConfig => {
  const t = (key: string): string => translator?.t(key) ?? '';
  const isContextMenu = config.type !== undefined;
  const localizeOption = (opt: CommandOption): LocalizedCommandOption => {
    const { choices, ...rest } = opt;
    const localizedChoices = choices?.map(
      (choice): LocalizedCommandChoice => ({
        value: choice.value,
        // A choice that already carries a `name` (data-file sourced)
        // keeps it; otherwise the label is resolved by stable `value`.
        name:
          choice.name ?? t(`commands:${config.name}.options.${opt.name}.choices.${choice.value}`),
      }),
    );
    return {
      ...rest,
      description: t(`commands:${config.name}.options.${opt.name}.description`),
      ...(localizedChoices ? { choices: localizedChoices } : {}),
    };
  };

  const localizedOptions: LocalizedCommandConfig['options'] | undefined = config.options
    ? Object.fromEntries(
        Object.entries(config.options).map(([optType, opts]) => [
          optType,
          (opts as CommandOption[]).map((opt) => localizeOption(opt)),
        ]),
      )
    : undefined;

  return {
    // A context-menu command's `config.name` is a stable ASCII id
    // (the handler directory name); its user-facing Discord name is
    // resolved from `commands:<id>.name`. Chat-input commands keep
    // their name (Discord requires a lowercase-ASCII command name,
    // which the id already is).
    name: isContextMenu ? t(`commands:${config.name}.name`) : config.name,
    ...(config.type !== undefined ? { type: config.type } : {}),
    // Context-menu commands carry no description; chat-input commands do.
    description: isContextMenu ? '' : t(`commands:${config.name}.description`),
    ...(localizedOptions ? { options: localizedOptions } : {}),
  };
};
