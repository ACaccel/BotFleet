# Upgrade notes

Use these notes when upgrading an installation that still uses the retired
features below. For routine code updates, see [deployment](contributing/deployment.md).
Current settings are documented in [Configuration](configuration.md).

## Migrating from `x_media_feed` to `social_feed`

A remaining `x_media_feed` block prevents startup. Subscriptions now live in each
guild's database rather than `config.json`.

1. Preserve the old `accounts` and `defaultChannel` values so you can recreate subscriptions.
2. Rename the block to `social_feed`; move `apiBaseUrl`, `timeoutMs` and
   `embedProxyHost` under `platforms.x`. Keep the polling options, but note that
   `maxPostsPerPoll` now applies per subscription, not per account. Follow the
   [nijika example](../src/bot/nijika/config.example.json).
3. Remove `accounts`, `defaultChannel` and the unused `guilds.<id>.channels.x_feed` mapping.
4. Add `feed_subscribe`, `feed_unsubscribe` and `feed_list` to `commands`, then
   run `npm run register -- -t nijika`. Review the
   [guild-command pruning behavior](contributing/local-setup.md#registering-slash-commands).
5. Re-add accounts with `/feed_subscribe`, specifying destination and media filter.
   Each call accepts up to 20 accounts. Check the per-account results, including
   failures and unattempted accounts if an upstream refusal ends the batch early.

New subscriptions do not backfill old posts. Old cursors are not migrated because
cursors now belong to individual platform/account/channel subscriptions. The
retired `xfeedcursors` collections remain until explicitly removed with
`npm run db -- drop-xfeed`; it counts only until `dry_run: false` is configured.
See the [database tool guide](../tools/db/README.md) before deleting collections.

## Recording removal rollout

Recording is no longer supported. Remove `record` from affected bots' `commands`,
stop the old processes, start the updated bots and re-register their commands to
remove `/record` from Discord.

Existing files under `data/voice_record` remain. Setup no longer installs FFmpeg
and does not uninstall an existing copy. Voice/stage channel text-message backups
remain supported.
