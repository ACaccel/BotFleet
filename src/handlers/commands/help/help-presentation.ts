/** Pure labels, descriptions and field packing for the `/help` views. */
import type { Translator } from '../../../core/i18n';
import type { Command } from '../command';
import type { HelpPath } from './help-model';

/** Discord's maximum embed field value length. */
export const FIELD_MAX = 1024;

type T = (key: string, params?: Record<string, string | number>) => string;

export const translate =
  (translator: Translator | undefined): T =>
  (key, params) =>
    translator?.t(key, params) ?? '';

export const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

export const isMenu = (command: Command): boolean => command.config.type !== undefined;

export const displayName = (command: Command, t: T): string =>
  isMenu(command) ? t(`commands:${command.config.name}.name`) : `/${command.config.name}`;

export const summary = (command: Command, t: T): string =>
  isMenu(command)
    ? t('replies:help.context_menu')
    : t(`commands:${command.config.name}.description`);

export const pathLabel = (path: HelpPath, t: T): string =>
  path.label.startsWith('/') ? path.label : t(path.label);

/** Pack lines into as few fields as fit Discord's per-field limit. */
export const packLines = (lines: readonly string[]): string[] => {
  const chunks: string[] = [];
  for (const line of lines) {
    const last = chunks.at(-1);
    if (last !== undefined && last.length + 1 + line.length <= FIELD_MAX) {
      chunks[chunks.length - 1] = `${last}\n${line}`;
    } else chunks.push(truncate(line, FIELD_MAX));
  }
  return chunks;
};
