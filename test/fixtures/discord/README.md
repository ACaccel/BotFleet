# Discord test fixtures

Minimal structural builders for the Discord types that handler / plugin
tests touch. Builders return plain objects shaped to the structural
minimum the SUT reads — no third-party mock libraries.

## Files

- `guild-builder.ts` — `buildGuild({ id, name, ownerId, channels, members, me, roles })`
  and `buildGuildRoles({ roleCount, roles, createdRoleId })`, whose
  `create` / `delete` mocks drive the role-creation failure branches.
  A role spec may set `position`, `permissions` and `managed` for the
  self-service role checks; `buildGuild` fills in each role's `guild`.
- `member-builder.ts` — `buildGuildMember({ id, displayName, roleIds, roles, highestRolePosition })`
  and `buildMemberRoles()` for the `roles.add` / `roles.remove` spies.
- `channel-builder.ts` — `buildTextChannel({ id, name, type, parent, viewableBy, permissionsBySubject })`
  for the `/traffic` visibility filter and for the `/feed_*` permission
  checks (it answers `isTextBased()`, `isSendable()` and `isThread()`
  from `type`), and `buildSendableChannel({ sendable })` for any path
  that posts a message and later deletes it.
- `interaction-builder.ts` — `buildChatInputInteraction({ commandName, userId, guildId, guild, options, channels, users, channel, memberPermissions, sink })`,
  `buildButtonInteraction({ customId, userId, guildId, guild, sink })`,
  `buildAutocompleteInteraction({ commandName, userId, guild, options, channel, focusedOption, focused, respondError, sink })`,
  `buildModalSubmitInteraction({ customId, userId, guildId, guild, channel, textInputs, selectValues, sink })`,
  `buildStringSelectInteraction({ customId, values, userId, guildId, guild, memberPermissions, channelMessages, sink })`
  and `buildUserContextMenuInteraction({ commandName, targetUser, targetMember, guildId, sink })`.
  The sink records `defers`, `replies`, `editReplies`, `updates`,
  `followUps` and `responses`, each with the `flags` it was sent with —
  that is how a test asserts a reply stayed ephemeral — and `modals`,
  the builders passed to `showModal`.
  `memberPermissions` is a flag list `memberPermissions.has` answers
  from; omitted, it is `null`, as outside a guild. `users` backs
  `options.getUser`, which throws for a missing required option as
  discord.js does; modal `fields` likewise throw for an absent field.
  `channelMessages` gives a select interaction a channel whose
  `messages.fetch` rejects any other id. The user-menu builder's
  `targetMember` is what `guild.members.fetch` resolves (`null`
  rejects, as for a non-member); both avatar URLs append the requested
  `?size=`, so a test can see the size asked for.
  `interaction.deferred` and `.replied` are live getters over the sink,
  so an error boundary picks `editReply` over `reply` exactly as it
  would at runtime. The autocomplete builder records `respond` calls in
  `responses` and answers `isRepliable()` with `false`, because an
  autocomplete interaction has no reply channel at all. `focusedOption`
  names the option `getFocused(true)` reports, and `respondError` drives
  the refused-response branch — pass a `DiscordAPIError` with code
  `10062` for the closed window specifically. Its `options` exposes
  `get` but no entity resolvers, mirroring discord.js v14, where
  `AutocompleteInteraction.options` omits `getChannel` / `getUser` /
  `getRole` and friends: Discord resolves entities only once the command
  is submitted, so an unsubmitted channel option carries its raw
  snowflake as the option value.
- `message-builder.ts` — `buildMessage(fields)`, a guild `Message` with
  ids, a human author, an empty attachment `Collection` and
  `partial: false`; `fields` overrides or extends them.
- `client-builder.ts` — `buildInertClient()`, the pre-login `Client` a
  composition-root test constructs a personality around.
- `bot-fake.ts` — `buildFakeBot(fields)` plus
  `echoTranslatorWithParams()`. Not a Discord type: a `BaseBot`
  stand-in for handler tests.

The sibling `test/fixtures/runtime.ts` holds the core runtime stand-ins
every layer receives: `echoTranslator()`, `silentLogger()` (a real
logger at `silent`; use a spy when logs are asserted) and
`buildPluginContext({ services, resolve, logger, translator, clock, eventName, registerInstance })`,
one object satisfying every plugin lifecycle context. Unbound tokens and
unexpected `registerInstance` calls throw.

The sibling `test/fixtures/handler-barrel-stubs.ts` holds the five
handler-barrel module stubs every test that boots a real `BaseBot`
needs; it is not a Discord type either, so it sits one level up.

## Conventions

- One file per Discord type.
- Tests import builders, not bare object literals, when the shape is
  used in 3 or more places.
- A builder that needs call recording returns the `vi.fn()` mocks
  alongside the built value (`{ guild, roles }`, `{ channel, send }`)
  rather than burying them behind the cast — the test can then both
  assert on and reprogram them.
- Builders cast to the public discord.js type at the end (`as unknown
as X`) — keep test files free of these casts so the shape change
  surface stays one file per type.

See `test/unit/core/plugin/router-dispatch.test.ts` for a test that
exercises the full router chain through these fixtures.
