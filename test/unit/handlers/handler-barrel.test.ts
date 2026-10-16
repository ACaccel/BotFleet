/**
 * Unit coverage for the barrel builders the four custom-id handler
 * families share (`src/handlers/index.ts`). Pins the two contracts each
 * `register<X>` / `execute<X>` pair carries: registration publishes one
 * instance per generated-registry entry and leaves the bot serving when
 * a constructor throws, and dispatch routes on the customId's leading
 * segment, ignoring a component another bot owns.
 */
import type { ButtonInteraction } from 'discord.js';
import { describe, expect, it } from 'vitest';

import {
  createCustomIdDispatcher,
  createHandlerRegistrar,
  HandlerFactory,
  type HandlerBarrelSpec,
} from '../../../src/handlers';
import type { BaseBot } from '../../../src/bot';
import { buildFakeBot } from '../../fixtures/discord/bot-fake';
import { buildButtonInteraction } from '../../fixtures/discord/interaction-builder';

const executions: string[] = [];

abstract class FakeHandler {
  public abstract execute(interaction: ButtonInteraction, bot: BaseBot): Promise<void>;
}

class Alpha extends FakeHandler {
  public async execute(): Promise<void> {
    executions.push('alpha');
  }
}

class Beta extends FakeHandler {
  public async execute(): Promise<void> {
    executions.push('beta');
  }
}

class Exploding extends FakeHandler {
  public constructor() {
    super();
    throw new Error('bad handler');
  }
  public async execute(): Promise<void> {}
}

interface Barrel {
  readonly spec: HandlerBarrelSpec<FakeHandler>;
  /** Stands in for the `BaseBot` field, seeded empty exactly as BaseBot seeds its own. */
  readonly assigned: { value: Map<string, FakeHandler> };
}

const barrelFor = (registry: Record<string, new () => FakeHandler>): Barrel => {
  const assigned: { value: Map<string, FakeHandler> } = { value: new Map() };
  return {
    assigned,
    spec: {
      registry,
      label: 'fake',
      assign: (_bot, handlers) => {
        assigned.value = handlers;
      },
      read: () => assigned.value,
    },
  };
};

const makeBot = (): BaseBot => buildFakeBot().bot;

const interactionWith = (customId: string): ButtonInteraction =>
  buildButtonInteraction({ customId });

describe('createHandlerRegistrar', () => {
  it('publishes one instance per registry entry', async () => {
    const { spec, assigned } = barrelFor({ alpha: Alpha, beta: Beta });

    await createHandlerRegistrar(spec)(makeBot());

    expect([...(assigned.value?.keys() ?? [])]).toEqual(['alpha', 'beta']);
    expect(assigned.value?.get('alpha')).toBeInstanceOf(Alpha);
    expect(assigned.value?.get('beta')).toBeInstanceOf(Beta);
  });

  it('leaves the bot serving when a handler constructor throws', async () => {
    const { spec, assigned } = barrelFor({ boom: Exploding });

    // Registration is best-effort by design: one broken handler family
    // must not abort startup for the rest of the bot.
    await expect(createHandlerRegistrar(spec)(makeBot())).resolves.toBeUndefined();
    // Nothing was published, so the family keeps the empty map BaseBot
    // seeded it with and its components are ignored, not answered.
    expect(assigned.value.size).toBe(0);
  });

  it('rejects a duplicate handler name at import, not at the first interaction', () => {
    // A codegen bug that emits one name twice must fail loudly at
    // startup rather than silently letting the last entry win.
    const factory = new HandlerFactory<FakeHandler>();
    factory.registerFromRegistry({ alpha: Alpha });
    expect(() => factory.registerFromRegistry({ alpha: Beta })).toThrow(/duplicate handler name/);
  });
});

describe('createCustomIdDispatcher', () => {
  it('routes on the leading customId segment', async () => {
    executions.length = 0;
    const { spec } = barrelFor({ alpha: Alpha, beta: Beta });
    const bot = makeBot();
    await createHandlerRegistrar(spec)(bot);

    await createCustomIdDispatcher(spec)(interactionWith('beta|42'), bot);

    expect(executions).toEqual(['beta']);
  });

  it('ignores a customId no registered handler claims', async () => {
    executions.length = 0;
    const { spec } = barrelFor({ alpha: Alpha });
    const bot = makeBot();
    await createHandlerRegistrar(spec)(bot);

    // Another bot in the same guild owns that component.
    await expect(
      createCustomIdDispatcher(spec)(interactionWith('someone-elses|1'), bot),
    ).resolves.toBeUndefined();
    expect(executions).toEqual([]);
  });

  it('ignores a component of a family whose registration failed', async () => {
    executions.length = 0;
    const { spec } = barrelFor({ alpha: Alpha });

    // No `register` call, so the family map is still the empty seed.
    await expect(
      createCustomIdDispatcher(spec)(interactionWith('alpha|1'), makeBot()),
    ).resolves.toBeUndefined();
    expect(executions).toEqual([]);
  });
});
