/**
 * Autocomplete dispatch — the contract that a member never sees a
 * failure and Discord never sees an invalid payload.
 *
 * An autocomplete interaction cannot be replied to, so there is no
 * user-facing failure mode to assert on: every one of these cases is
 * pinned by what reaches `respond`. The load-bearing claims are that
 * something is always responded with, that it always fits Discord's
 * limits, and that nothing here ever rejects — the middleware chain
 * that called it still has stages left to run.
 */
import { describe, expect, it, vi, type Mock } from 'vitest';
import { DiscordAPIError, type AutocompleteInteraction } from 'discord.js';

import type { BaseBot } from '../../../src/bot';
import { Command, type CommandSuggestions } from '../../../src/handlers/commands/command';
import { executeAutocomplete } from '../../../src/handlers/commands/autocomplete';
import {
  MAX_AUTOCOMPLETE_CHOICES,
  MAX_AUTOCOMPLETE_FIELD_LENGTH,
} from '../../../src/infra/discord/autocomplete-limits';
import { buildFakeBot } from '../../fixtures/discord/bot-fake';
import {
  buildAutocompleteInteraction,
  newInteractionSink,
} from '../../fixtures/discord/interaction-builder';

/**
 * A command whose hook answers with whatever the test hands it. The
 * arguments are forwarded rather than dropped, so a test can assert
 * what the dispatcher actually passes the hook.
 */
class Suggesting extends Command {
  public constructor(
    private readonly answer: (
      interaction: AutocompleteInteraction,
      bot: BaseBot,
    ) => Promise<CommandSuggestions>,
  ) {
    super();
    this.setConfig({ name: 'suggesting' });
  }
  public override autocomplete(
    interaction: AutocompleteInteraction,
    bot: BaseBot,
  ): Promise<CommandSuggestions> {
    return this.answer(interaction, bot);
  }
  public override async execute(): Promise<void> {}
}

/** A command that declares no hook at all — the common case. */
class Silent extends Command {
  public constructor() {
    super();
    this.setConfig({ name: 'silent' });
  }
  public override async execute(): Promise<void> {}
}

interface Fixture {
  readonly handlers?: Readonly<Record<string, Command>>;
  readonly commandName?: string;
  readonly respondError?: Error;
}

const build = (fixture: Fixture = {}) => {
  const { bot, logger } = buildFakeBot({
    commandHandlers: new Map(Object.entries(fixture.handlers ?? {})),
  });
  const sink = newInteractionSink();
  const interaction = buildAutocompleteInteraction({
    commandName: fixture.commandName ?? 'suggesting',
    ...(fixture.respondError === undefined ? {} : { respondError: fixture.respondError }),
    sink,
  });
  return { bot: bot as BaseBot, interaction, sink, logger };
};

/** The `Error` a `logError` call put on the spy logger. */
const loggedError = (logger: { error: Mock }): Error => {
  const record = logger.error.mock.calls[0]?.[0] as { err?: unknown } | undefined;
  const err = record?.err;
  if (!(err instanceof Error)) throw new TypeError('expected logError to record an Error');
  return err;
};

/** A Discord rejection carrying `code`, the way the real client raises it. */
const discordError = (code: number, message: string): DiscordAPIError =>
  new DiscordAPIError({ message, code }, code, 404, 'POST', 'https://discord.test/callback', {});

/** The single choice list `respond` was called with. */
const responded = (sink: ReturnType<typeof newInteractionSink>) => {
  expect(sink.responses).toHaveLength(1);
  return sink.responses[0] ?? [];
};

describe('executeAutocomplete', () => {
  it('answers with the named command hook suggestions', async () => {
    const hook = vi.fn(async () => [{ name: 'X @alice', value: 'alice' }]);
    const { bot, interaction, sink } = build({ handlers: { suggesting: new Suggesting(hook) } });

    await executeAutocomplete(interaction, bot);

    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(interaction, bot);
    expect(responded(sink)).toEqual([{ name: 'X @alice', value: 'alice' }]);
  });

  it('answers empty for a command that declares no hook', async () => {
    const { bot, interaction, sink } = build({
      handlers: { silent: new Silent() },
      commandName: 'silent',
    });

    await executeAutocomplete(interaction, bot);

    // Empty rather than silence: Discord shows a stale list until it is
    // told there is nothing, so skipping `respond` is not the same.
    expect(responded(sink)).toEqual([]);
  });

  it('answers empty for a command name it does not know', async () => {
    const { bot, interaction, sink } = build({ handlers: {}, commandName: 'ghost' });

    await executeAutocomplete(interaction, bot);

    expect(responded(sink)).toEqual([]);
  });

  it('answers empty and logs when the hook throws', async () => {
    const boom = new Error('hook exploded');
    const { bot, interaction, sink, logger } = build({
      handlers: {
        suggesting: new Suggesting(() => Promise.reject(boom)),
      },
    });

    await executeAutocomplete(interaction, bot);

    expect(responded(sink)).toEqual([]);
    // A throwing hook is a defect, and the operator log is the only
    // place it can possibly surface — so the line has to carry enough
    // to act on: which command, and the original failure as `cause`.
    expect(logger.error).toHaveBeenCalledTimes(1);
    const logged = loggedError(logger);
    expect(logged.message).toContain('suggesting');
    expect(logged.cause).toBe(boom);
  });

  it('caps the answer at Discord ceiling of 25 choices', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      name: `X @a${String(i)}`,
      value: `a${String(i)}`,
    }));
    const { bot, interaction, sink } = build({
      handlers: { suggesting: new Suggesting(async () => many) },
    });

    await executeAutocomplete(interaction, bot);

    const choices = responded(sink);
    expect(choices).toHaveLength(MAX_AUTOCOMPLETE_CHOICES);
    // Kept in the order the hook ranked them, so the best are not the
    // ones dropped.
    expect(choices[0]).toEqual({ name: 'X @a0', value: 'a0' });
  });

  it('truncates a name and a value past the 100-character ceiling', async () => {
    const { bot, interaction, sink } = build({
      handlers: {
        suggesting: new Suggesting(async () => [{ name: 'n'.repeat(180), value: 'v'.repeat(180) }]),
      },
    });

    await executeAutocomplete(interaction, bot);

    const [choice] = responded(sink);
    expect(choice?.name).toHaveLength(MAX_AUTOCOMPLETE_FIELD_LENGTH);
    expect(String(choice?.value)).toHaveLength(MAX_AUTOCOMPLETE_FIELD_LENGTH);
  });

  it('files a closed window as routine, not as a defect', async () => {
    const { bot, interaction, logger } = build({
      handlers: { suggesting: new Suggesting(async () => [{ name: 'X @a', value: 'a' }]) },
      // 10062 Unknown Interaction — the three-second window elapsed.
      respondError: discordError(10062, 'Unknown interaction'),
    });

    // Rejecting here would reach the bridge, which would try to reply
    // to an interaction that cannot be replied to.
    await expect(executeAutocomplete(interaction, bot)).resolves.toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
    // The code is what tells an operator this was the window and not a
    // rejected payload.
    expect(String(logger.info.mock.calls[0]?.[0])).toContain('10062');
  });

  it('files any other rejection at error level, since nothing else reports it', async () => {
    const { bot, interaction, logger } = build({
      handlers: { suggesting: new Suggesting(async () => [{ name: 'X @a', value: 'a' }]) },
      // A rejected payload is a real fault, and this surface shows the
      // member an empty dropdown either way — so filing it as routine
      // would make a systematically broken autocomplete invisible.
      respondError: discordError(50035, 'Invalid Form Body'),
    });

    await expect(executeAutocomplete(interaction, bot)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(loggedError(logger).message).toContain('suggesting');
  });

  it('files a hook that returned a malformed choice as a hook defect', async () => {
    const { bot, interaction, sink, logger } = build({
      handlers: {
        // Only reachable from JavaScript; `CommandSuggestions` forbids it.
        suggesting: new Suggesting(async () => [{ name: 42, value: 'a' }] as never),
      },
    });

    await executeAutocomplete(interaction, bot);

    // Not laundered into the delivery-failure branch: bounding runs
    // inside the hook guard precisely so this stays the handler's fault.
    expect(responded(sink)).toEqual([]);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
