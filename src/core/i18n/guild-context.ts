import { AsyncLocalStorage } from 'node:async_hooks';
import type { Locale, Translator } from './translator';

export interface GuildLocaleSettings {
  readonly language: Locale;
  readonly timeZone: string;
}

interface ExecutionScope extends GuildLocaleSettings {
  readonly owner: GuildLocaleContext;
  readonly guildId: string | undefined;
}

const execution = new AsyncLocalStorage<ExecutionScope>();

/** One owner per bot keeps nested and concurrent personalities isolated. */
export class GuildLocaleContext {
  public constructor(
    private readonly resolve: (guildId: string | undefined) => GuildLocaleSettings,
  ) {}

  public get current(): GuildLocaleSettings {
    const scope = execution.getStore();
    return scope?.owner === this ? scope : this.resolve(undefined);
  }

  public get active(): boolean {
    return execution.getStore()?.owner === this;
  }

  public run<T>(guildId: string | undefined, callback: () => T): T {
    return execution.run({ ...this.resolve(guildId), owner: this, guildId }, callback);
  }

  public translator(base: Translator): Translator {
    return {
      t: (key, params, locale) => base.t(key, params, locale ?? this.current.language),
      tStrict: (key, params, locale) => base.tStrict(key, params, locale ?? this.current.language),
      listMissingKeys: (reference) => base.listMissingKeys(reference),
      withGuildContext: (guildId, callback) => this.run(guildId, callback),
    };
  }
}

/** Optional on test/legacy translators so existing personalities need no new collaborator. */
export const withGuildContext = <T>(
  translator: Translator | undefined,
  guildId: string | undefined,
  callback: () => T,
): T =>
  translator?.withGuildContext ? translator.withGuildContext(guildId, callback) : callback();

/** node-schedule shares timer queues; bind guild identity explicitly and refresh preferences at execution. */
export const bindGuildContext = <T extends readonly unknown[], R>(
  callback: (...args: T) => R,
): ((...args: T) => R) => {
  const scope = execution.getStore();
  return scope ? (...args) => scope.owner.run(scope.guildId, () => callback(...args)) : callback;
};
