# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/):
one imperative line per notable change, grouped by kind under the release
it shipped in, each entry closing with a link to the commit that made it.
Entries describe what changed for a user or an operator, not how it was
implemented, and are written in one pass when a release is cut. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); entries marked
**breaking** need an operator action described in [`README.md`](README.md)
or [`CONTRIBUTING.md`](CONTRIBUTING.md).

## [Unreleased]

### Added

- Let slash-command string options offer autocomplete suggestions, answered by a per-command hook ([9425594](https://github.com/ACaccel/pleiades-fleet/commit/9425594)).
- Suggest the accounts a channel has already subscribed while the `/feed_unsubscribe` account list is being typed ([8557a98](https://github.com/ACaccel/pleiades-fleet/commit/8557a98)).

### Changed

- Ask for confirmation before `/feed_unsubscribe` clears a whole channel, and list its options as platform, account, then channel to match `/feed_subscribe` ([8557a98](https://github.com/ACaccel/pleiades-fleet/commit/8557a98)).
- Show the media filter on every `/feed_list` line, including subscriptions on the default photo-or-video filter, which previously carried no label ([8557a98](https://github.com/ACaccel/pleiades-fleet/commit/8557a98)).
- State the filter now in force on each account `/feed_subscribe` creates or updates, so a re-subscribe that clears a keyword no longer looks like it kept one ([8557a98](https://github.com/ACaccel/pleiades-fleet/commit/8557a98)).
- Spell out in the `/feed_subscribe` media choices which posts each one forwards (text-only, photo, video), and label the `/feed_list` filter the same way ([a11f752](https://github.com/ACaccel/pleiades-fleet/commit/a11f752)).
- Replace the configured X account list with per-channel feed subscriptions managed by `/feed_subscribe`, `/feed_unsubscribe` and `/feed_list`, which take several accounts at a time, and open the feed to further platforms (**breaking** — see [`README.md`](README.md)) ([40dd11e](https://github.com/ACaccel/pleiades-fleet/commit/40dd11e)).
- Probe every configured embed-proxy host until one yields a playable video or the list ends, and drop the `validationBudgetMs` setting (**breaking** — delete the key from each bot's `config.json`; see [`README.md`](README.md)) ([adcee34](https://github.com/ACaccel/pleiades-fleet/commit/adcee34)).
- Split the contributing guide into per-topic documents ([72ecc17](https://github.com/ACaccel/pleiades-fleet/commit/72ecc17)).

### Fixed

- Abandon an attachment download only when no bytes arrive for 30 s or it runs past 10 minutes, instead of after a fixed 30 s, so a large or slow attachment is cached rather than dropped with a bare `canceled` warning ([d34a4c5](https://github.com/ACaccel/pleiades-fleet/commit/d34a4c5)).
- Retry a Discord fetch that fails with a host- or network-unreachable socket error, and let the message backup wait out an outage of several minutes before giving up on a channel ([1e45d31](https://github.com/ACaccel/pleiades-fleet/commit/1e45d31)).
- Report the number of failed channels in the message backup's completion message, so a partial pass is visible in the debug channel ([57f6fa6](https://github.com/ACaccel/pleiades-fleet/commit/57f6fa6)).
- Probe two live Instagram embed-proxy hosts ahead of the two whose name servers stopped answering, so Instagram links preview again (copy the new `instagramProxyHosts` order from `config.example.json`) ([cf91447](https://github.com/ACaccel/pleiades-fleet/commit/cf91447)).
- Bound the name lookup of every embed-proxy probe, so a proxy host with dead name servers no longer stalls the bot's other network calls ([74d8e05](https://github.com/ACaccel/pleiades-fleet/commit/74d8e05)).
- Strip Instagram's `igsi` share token from links before previewing them ([1096a50](https://github.com/ACaccel/pleiades-fleet/commit/1096a50)).
- Cache attachments before deletion and retry the download, so deleted-attachment archival stops losing files (see [`README.md`](README.md) for the cache settings) ([5491f89](https://github.com/ACaccel/pleiades-fleet/commit/5491f89)).

## [1.1.0] - 2026-08-31

### Added

- Add link previews for Twitter/X, Instagram, Threads, Facebook, and Bahamut links, replacing the original auto-embed ([2fefa76](https://github.com/ACaccel/pleiades-fleet/commit/2fefa76)).
- Add link previews for Reddit posts, comment permalinks, and share links ([77d5e78](https://github.com/ACaccel/pleiades-fleet/commit/77d5e78)).
- Add the `gopher` personality — a database-free bot with a self-hosted-LLM auto-reply and an owner-only settings API ([74c7a44](https://github.com/ACaccel/pleiades-fleet/commit/74c7a44)).
- Add the `/traffic` and `/traffic_me` message statistics, gated by a configurable permission rank ([0d65612](https://github.com/ACaccel/pleiades-fleet/commit/0d65612)).
- Add an ops tool that audits, converts, and indexes stored message timestamps ([043e0e4](https://github.com/ACaccel/pleiades-fleet/commit/043e0e4)).
- Add `/traffic_user` for another member's message statistics, gated by the invoker's clearance ([bf1c6a9](https://github.com/ACaccel/pleiades-fleet/commit/bf1c6a9)).
- Add link previews for Bilibili videos ([b3a22af](https://github.com/ACaccel/pleiades-fleet/commit/b3a22af)).
- Resolve Bilibili short links to the full video URL before previewing them ([5c383fc](https://github.com/ACaccel/pleiades-fleet/commit/5c383fc)).
- Add `/temp_role` for self-claimed notification roles that expire after 30 days ([e4078f3](https://github.com/ACaccel/pleiades-fleet/commit/e4078f3)).
- Enable link previews, `/temp_role`, and a custom ready-time presence on `tomori` ([6aef6ad](https://github.com/ACaccel/pleiades-fleet/commit/6aef6ad)).
- Forward new image and video posts from followed X accounts to a guild feed channel, resuming after a restart ([69e83b4](https://github.com/ACaccel/pleiades-fleet/commit/69e83b4)).

### Changed

- Move the per-user lucky replies into per-bot configuration (**breaking** — see [`README.md`](README.md)) ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Move the weather location and the restaurant recommendation endpoint into configuration (**breaking** — see [`README.md`](README.md)) ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Read command options through typed accessors and route outbound requests through a timeout-bounded HTTP client ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Move the shared command-support code out of the feature layer and fail the build on a layering violation ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Validate third-party API responses, so a changed upstream shape reports an error instead of an empty result ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Rename the last remaining `discord-bot` reference to BotFleet ([16cb24f](https://github.com/ACaccel/pleiades-fleet/commit/16cb24f)).
- Apply a ranked category's permission rank to every channel and thread beneath it ([7fabeca](https://github.com/ACaccel/pleiades-fleet/commit/7fabeca)).
- Serve message-timestamp range queries from an index ([7629d45](https://github.com/ACaccel/pleiades-fleet/commit/7629d45)).
- Replace the `/giveaway_create` and `/giveaway_delete` command options with a modal and a select menu ([b238205](https://github.com/ACaccel/pleiades-fleet/commit/b238205)).
- Expand role mentions in `/roll_call`, capped at 50 unique members ([e476c4c](https://github.com/ACaccel/pleiades-fleet/commit/e476c4c)).
- Consolidate the three database ops tools into one `yarn db <subcommand>` CLI (**breaking** — see [`CONTRIBUTING.md`](CONTRIBUTING.md)) ([8a9c2cc](https://github.com/ACaccel/pleiades-fleet/commit/8a9c2cc)).
- Record every message edit and delete locally, and make the msg-archive transcript log opt-in ([971f923](https://github.com/ACaccel/pleiades-fleet/commit/971f923)).
- Simplify the plugin contract to a lifecycle and event surface, with each plugin parsing its own config ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Isolate plugin lifecycle failures, so no single plugin can abort startup ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Move the service-token catalog out of the core layer to fix a layering violation ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Reduce the dependency container to a single singleton lifetime ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Make error class identity the sole dispatch contract and drop the parallel tag from log records ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Fail the build on an unused export or type, and extend the scan to the ops tools ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Replace the unmaintained voice-encryption backend, removing the native build step from `yarn install` ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).

### Fixed

- Run a graceful shutdown on `SIGINT` / `SIGTERM` instead of killing the process mid-work; a second signal exits immediately ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Exit non-zero when a personality fails to start, instead of leaving a live process with nothing registered ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Tear down plugins disabled after startup, which leaked their listeners and subscriptions ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Close the HTTP servers under a bounded timeout during shutdown ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Load the AccuWeather key from the environment, which had silently disabled `/weather_forecast` ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Reply in the configured language when a giveaway or activity delete fails ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Tally `/roll_call` reactions correctly on an English-locale bot ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Localise the `/ai_settings` modal labels and the unknown-price text in the LLM usage footer ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Include the trace id on the `/record` failure reply, as the message promises ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Fall back to standard error when a log file cannot be written, instead of crashing on a full disk ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Bound every model-list fetch, so a stalled provider no longer wedges the `/ai_settings` model menu ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Cap chat session history and evict idle sessions, bounding request size and memory growth ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Bound deleted-attachment downloads by timeout, size, and concurrency ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Discard a database connection that opens after shutdown began, which leaked a socket ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Log a failed scheduled job instead of dropping it silently ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Register commands independently, so one misconfigured handler no longer aborts the rest ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Distinguish an upstream failure from an empty result instead of reporting both as "no restaurants found" ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Answer an unregistered guild or a malformed level-role configuration instead of crashing, and log the malformed block ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Report the real command-registration outcome for a newly joined guild ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Log the errors from a failed timeout and from the deleted-message fallback ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Report a missing database connection on the database-free personality instead of throwing ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Exit non-zero when a fault lands mid-shutdown, instead of reporting a crash as a clean stop ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Stop a failed startup from registering guilds on a half-wired bot that is about to exit ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Release a partially started bot's port and connections before exiting ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Bound the shutdown drain, so a database outage during Ctrl+C no longer forces a hard kill ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Expand Facebook share short links to the full permalink before previewing them ([683c130](https://github.com/ACaccel/pleiades-fleet/commit/683c130)).
- Restore the type-check and unit-test gates after the `gopher` release ([2b0384b](https://github.com/ACaccel/pleiades-fleet/commit/2b0384b)).
- Tolerate a transient network reset instead of crashing, and keep the message-backup loop running after a failed pass ([8992fec](https://github.com/ACaccel/pleiades-fleet/commit/8992fec)).
- Restore Threads and X previews, reject login-wall cards, and move the preview host lists into operator config (**breaking** — see [`README.md`](README.md)) ([ea4bec6](https://github.com/ACaccel/pleiades-fleet/commit/ea4bec6)).

### Removed

- Remove the `todo_list` feature permanently (**breaking**) ([a5b6764](https://github.com/ACaccel/pleiades-fleet/commit/a5b6764)).
- Remove `/pin_message`, superseded by Discord's native thread-pin permission (**breaking**) ([1b8f144](https://github.com/ACaccel/pleiades-fleet/commit/1b8f144)).
- Drop the completed phased-rollout scaffolding ([65eb7b6](https://github.com/ACaccel/pleiades-fleet/commit/65eb7b6)).
- Strip refactoring residue and dead code ([ecbe555](https://github.com/ACaccel/pleiades-fleet/commit/ecbe555)).
- Remove `/inspect_member_ids` (**breaking** — see [`README.md`](README.md)) ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Remove the unused parts of the plugin contract, leaving code generation as the only handler-registration mechanism ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Remove the unused container lifetimes and the scope API ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Remove five unreferenced error classes and their message copy ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Remove three unused identifier types ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Remove seven orphaned reply strings ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).

### Security

- Fail the dependency-audit step on an advisory, which the pipeline had been reporting as a success ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Redact the remaining API keys and strip credentials from URL query strings before they reach a log ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Send the Gemini API key in a header instead of the request URL ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Redact database connection-string credentials, which reached the log verbatim inside an error message ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Send operator-configured replies with mentions disabled, so a stray `@everyone` cannot ping ([a6e8a12](https://github.com/ACaccel/pleiades-fleet/commit/a6e8a12)).
- Upgrade the test toolchain to clear four HIGH/CRITICAL advisories ([2a37a09](https://github.com/ACaccel/pleiades-fleet/commit/2a37a09)).
- Bump transitive `undici` to clear GHSA-vxpw-j846-p89q ([f8a72fb](https://github.com/ACaccel/pleiades-fleet/commit/f8a72fb)).
- Upgrade `axios` and re-resolve four transitive packages to clear the fixable HIGH+ advisories ([dce0457](https://github.com/ACaccel/pleiades-fleet/commit/dce0457)).
- Re-resolve `nanoid` onto a patched release and allowlist the unfixable `tar` advisory ([fd370ea](https://github.com/ACaccel/pleiades-fleet/commit/fd370ea)).

## [1.0.0] - 2026-05-31

Initial public release: the codebase was rebuilt from a flat script
collection into the layered, plugin-based architecture described in
[`docs/architecture.md`](docs/architecture.md). The notable changes of
that rebuild:

### Added

- Establish the engineering baseline — strict TypeScript, linting, formatting, tests, and the i18n scaffolding ([d02ee4d](https://github.com/ACaccel/pleiades-fleet/commit/d02ee4d)).
- Add typed database schemas and the generated handler registry with a CI drift check ([546e25a](https://github.com/ACaccel/pleiades-fleet/commit/546e25a)).
- Add the typed dependency container and the persistence layer ([146edcc](https://github.com/ACaccel/pleiades-fleet/commit/146edcc)).
- Complete the repository layer and migrate the first batch of handlers onto it ([488b57e](https://github.com/ACaccel/pleiades-fleet/commit/488b57e)).
- Add the structured error taxonomy, the result type, structured logging, and the process-level safety nets ([4287dc2](https://github.com/ACaccel/pleiades-fleet/commit/4287dc2)).
- Add the plugin contract, the plugin host, and the interaction and event routing ([73aadcd](https://github.com/ACaccel/pleiades-fleet/commit/73aadcd)).
- Wire the plugin host into the bot lifecycle ([954c7c9](https://github.com/ACaccel/pleiades-fleet/commit/954c7c9)).
- Migrate the event handlers into the auto-reply and guild-events plugins ([fca53e7](https://github.com/ACaccel/pleiades-fleet/commit/fca53e7)).
- Migrate the remaining features and msg-archive into plugins ([c480b7c](https://github.com/ACaccel/pleiades-fleet/commit/c480b7c)).
- Add the LLM provider layer for OpenAI, Anthropic, Gemini, and xAI, with contract tests ([80e35ac](https://github.com/ACaccel/pleiades-fleet/commit/80e35ac)).
- Add the CJK-literal scanner and the seeded bilingual catalogs ([a4cd0b3](https://github.com/ACaccel/pleiades-fleet/commit/a4cd0b3)).
- Land the bilingual catalog and per-feature failure messages ([b4c7906](https://github.com/ACaccel/pleiades-fleet/commit/b4c7906)).
- Add `yarn smoke`, a pre-deploy probe over environment load, database ping, and Discord login ([2422c69](https://github.com/ACaccel/pleiades-fleet/commit/2422c69)).
- Add the unused-code and declaration-build gates ([7114323](https://github.com/ACaccel/pleiades-fleet/commit/7114323)).
- Add test coverage thresholds and the coverage CI gate ([06e15c0](https://github.com/ACaccel/pleiades-fleet/commit/06e15c0)).
- Retry a failed database connection and skip the guild meanwhile, so one guild's outage cannot stop the bot ([4950833](https://github.com/ACaccel/pleiades-fleet/commit/4950833)).
- Extract the bot startup into separate lifecycle phases behind a guild-onboarding port ([545d4d6](https://github.com/ACaccel/pleiades-fleet/commit/545d4d6)).
- Add the earthquake plugin and route reactions through the structured logger ([8652208](https://github.com/ACaccel/pleiades-fleet/commit/8652208)).
- Add structured guild-event details and per-date log file routing ([e53c171](https://github.com/ACaccel/pleiades-fleet/commit/e53c171)).
- Add the full-history message re-ingest tool ([f42a969](https://github.com/ACaccel/pleiades-fleet/commit/f42a969)).
- Add the database integrity-check tool ([11c4451](https://github.com/ACaccel/pleiades-fleet/commit/11c4451)).
- Run the ops-tools test project and cover the `dev` branch in the CI triggers ([72e52c6](https://github.com/ACaccel/pleiades-fleet/commit/72e52c6)).
- Give each backup pass a timestamped transcript path, so a rerun cannot overwrite the prior one ([7536bbd](https://github.com/ACaccel/pleiades-fleet/commit/7536bbd)).
- Pick the cheapest still-listed model by default, refreshed weekly ([e8b7248](https://github.com/ACaccel/pleiades-fleet/commit/e8b7248)).
- Add configurable language and admin settings, optional guild channel maps, and a categorised `/help` ([cbaf8f7](https://github.com/ACaccel/pleiades-fleet/commit/cbaf8f7)).
- Add `--dry-run` to verify localised command text without registering it ([f7e24a6](https://github.com/ACaccel/pleiades-fleet/commit/f7e24a6)).
- Prune guild-scoped commands on a global deploy, so a stale registration cannot shadow the global one ([25fea6d](https://github.com/ACaccel/pleiades-fleet/commit/25fea6d)).
- Add the self-hosted-LLM auto-reply plugin ([825bf38](https://github.com/ACaccel/pleiades-fleet/commit/825bf38)).
- Expose the bot's guild information through a read-only accessor ([4d30216](https://github.com/ACaccel/pleiades-fleet/commit/4d30216)).
- Add [`docs/architecture.md`](docs/architecture.md) as the single-page architecture overview ([9cbf68a](https://github.com/ACaccel/pleiades-fleet/commit/9cbf68a)).
- Adopt the Git Flow branching model (`main` + `dev`) ([a134f72](https://github.com/ACaccel/pleiades-fleet/commit/a134f72)).

### Changed

- Kebab-case the bot and handler directories ([ed9096f](https://github.com/ACaccel/pleiades-fleet/commit/ed9096f)).
- Unify the repository boundary on a single result type ([05670ca](https://github.com/ACaccel/pleiades-fleet/commit/05670ca)).
- Extend the strict type check to the whole source tree ([a7a9c4b](https://github.com/ACaccel/pleiades-fleet/commit/a7a9c4b)).
- Expand the lint scope to the whole source tree and remove the remaining untyped values ([7f7a566](https://github.com/ACaccel/pleiades-fleet/commit/7f7a566)).
- Separate the bootstrap logger from the runtime logger ([aeecff0](https://github.com/ACaccel/pleiades-fleet/commit/aeecff0)).
- Drop the redundant client id from the log helpers ([dffce92](https://github.com/ACaccel/pleiades-fleet/commit/dffce92)).
- Strip the bot name from file log output, since the path already encodes it ([1cb2dec](https://github.com/ACaccel/pleiades-fleet/commit/1cb2dec)).
- Rename the project to BotFleet ([04d5357](https://github.com/ACaccel/pleiades-fleet/commit/04d5357)).

### Fixed

- Register the ready listener before login, so the reboot message fires ([dec2700](https://github.com/ACaccel/pleiades-fleet/commit/dec2700)).
- Tolerate a failed model initialisation, so database-backed commands keep working ([831ae20](https://github.com/ACaccel/pleiades-fleet/commit/831ae20)).
- Break a circular import in the handler registry ([430c45a](https://github.com/ACaccel/pleiades-fleet/commit/430c45a)).
- Restore tomori's guild-event logging and rework giveaway publishing ([fe59b60](https://github.com/ACaccel/pleiades-fleet/commit/fe59b60)).
- Paginate the guild list, so the command prune covers more than 200 guilds ([eb09993](https://github.com/ACaccel/pleiades-fleet/commit/eb09993)).
- Back up archived private threads ([b1f9d54](https://github.com/ACaccel/pleiades-fleet/commit/b1f9d54)).
- Paginate archived threads correctly during a backup ([fcd4273](https://github.com/ACaccel/pleiades-fleet/commit/fcd4273)).

### Removed

- Remove the text-to-speech feature and rewrite the source comments in a release voice ([6a9041f](https://github.com/ACaccel/pleiades-fleet/commit/6a9041f)).
- Migrate message-backup onto the repository layer and delete the legacy database shim ([1e28b31](https://github.com/ACaccel/pleiades-fleet/commit/1e28b31)).
- Fold the feature modules into the plugins and delete the stale path aliases ([2dddacc](https://github.com/ACaccel/pleiades-fleet/commit/2dddacc)).
- Drop the unused fallback bucket from the log file router ([42539dd](https://github.com/ACaccel/pleiades-fleet/commit/42539dd)).
- Stop audit-logging message creation, which drowned every other event ([3cd9312](https://github.com/ACaccel/pleiades-fleet/commit/3cd9312)).
- Stop audit-logging reaction events, for the same reason ([661a727](https://github.com/ACaccel/pleiades-fleet/commit/661a727)).
- Delete the internal engineering working documents ([d8e2cd9](https://github.com/ACaccel/pleiades-fleet/commit/d8e2cd9)).

### Security

- Allowlist GHSA-r5fr-rjxr-66jc, which has no in-range remediation ([30e670c](https://github.com/ACaccel/pleiades-fleet/commit/30e670c)).

[1.1.0]: https://github.com/ACaccel/pleiades-fleet/releases/tag/v1.1.0
[1.0.0]: https://github.com/ACaccel/pleiades-fleet/releases/tag/v1.0.0
