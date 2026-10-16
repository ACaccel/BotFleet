/**
 * Branded ID types.
 *
 * Discord and Mongo both surface IDs as plain strings, so a `string`
 * parameter cannot tell a guild id from a channel id. The structural brand
 * below makes the compiler refuse to interchange them at zero runtime cost.
 *
 * Only the two ids keyed on at the data layer carry a brand; one per Discord
 * snowflake would add noise at every call site. Call the `as*` constructors
 * at the boundary where untyped strings (Discord SDK, env) enter the system.
 */
type Brand<T, B> = T & { readonly __brand: B };

export type GuildId = Brand<string, 'GuildId'>;
export type ChannelId = Brand<string, 'ChannelId'>;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const brandCheck = (kind: string, value: unknown): string => {
  if (!isNonEmptyString(value)) {
    throw new TypeError(`Expected non-empty string for ${kind}, got ${typeof value}`);
  }
  return value;
};

export const asGuildId = (value: unknown): GuildId => brandCheck('GuildId', value) as GuildId;
export const asChannelId = (value: unknown): ChannelId =>
  brandCheck('ChannelId', value) as ChannelId;
