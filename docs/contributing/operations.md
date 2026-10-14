# Operations

For service commands and rollback, see [deployment](deployment.md).

## Command logs

For debug-channel embed contents, language, permissions and suppression behavior,
see [the configuration reference](../configuration.md#common-bot-settings).

## Role and posting commands

See [role and posting configuration](../configuration.md#roles-and-posting) for
temporary-role limits, early cancellation, level-role synchronization and signed
posting. For retired command IDs, follow the
[role and talk migration](../upgrading.md#role-and-talk-command-migration) before
deployment and command registration.

## Host migration

Follow the [migration runbook](../../tools/migration/README.md) for host transfer and cutover.

## Recording removal rollout

Follow the [recording removal checklist](../upgrading.md#recording-removal-rollout)
when upgrading an older deployment.

## Pre-deploy smoke

Before release promotion, run with a real bot `.env` and network access:

```bash
npm run smoke                     # defaults to nijika
npm run smoke -- --bot konata
SMOKE_TIMEOUT_MS=60000 npm run smoke -- --bot tomori
```

The check validates environment values, authenticated MongoDB `admin.ping` (when
configured), and Discord login against `CLIENT_ID`. Steps time out after 30 seconds;
failure reports the step and exits with status `1`. It runs separately from CI and
does not exercise commands, plugins, or HTTP routes.

## Temporary moderation

For persistent thread-owner controls on Nijika, use
[`/thread ban`, `/thread allow`, and `/thread list`](../thread-moderation.md).
Replacement accounts can use `/thread claim`; configured admins approve through
DM or use `/thread manager` for direct grants and revocation. See
[DM review](../thread-moderation.md#delegated-management-and-dm-review) for delivery failures.

After a successful `/ban_user` vote, a rejected Discord timeout activates message
deletion and suppresses configured/self-hosted LLM auto-replies, even if deletion
fails. This fallback lasts for the requested duration, applies only to that guild
and bot process, and ends early on restart. Native timeouts remain managed by Discord.

## Dependency overrides

Recheck the `undici: ^6.27.0` security override on each Discord dependency upgrade;
remove it when the upstream pin includes the fix. Run `npm explain <pkg>` before
adding overrides.

The `vitest`-scoped `tinypool: 2.1.2` override fixes prototype-pollution and
code-execution advisories in the test worker pool. Keep it scoped to Vitest and
remove it when a Vitest upgrade permits a patched version without an override.
The lockfile also updates `proxy-addr` and `source-map-js` to patched releases
within their existing dependency ranges.

## Database recovery

Transient failures retry in the background using
[`MONGO_RECOVERY_INTERVAL_MS`](../configuration.md); recovered guilds regain their
repositories and jobs. Match giveaway error IDs to connection logs. Restore MongoDB
or its network route for refused connections; fix authentication/authorization or
other persistent failures, then restart the bot.

## Message archive maintenance

Use [archive operations](../message-archive.md) for health, capacity, owner recovery,
the full backup and the periodic schedule through `/archive` in the configured guild
debug channel; only users in msg-archive's `admin` list can use it. Local tests do
not authorize a production backup. Whole-database
transfer remains in the [migration runbook](../../tools/migration/README.md).

Start a [full backup](../message-archive.md#full-backup) with `/archive backup` and
confirm once. Its public panel updates every ten seconds and offers **Stop** and
**Gap details**; a stopped or failed backup offers **Resume**, which keeps the cutoff
and checkpoints. A backup interrupted by a restart continues automatically.
`/archive status` shows the latest results, coverage, live capture and capacity.

Periodic scans are disabled until explicitly enabled per guild. After the first
full backup, use [`/archive schedule enabled:true minutes:60`](../message-archive.md#periodic-schedule)
to save an interval and enable scanning in one command. Repeating saved settings
preserves the next due time. Disabling it leaves live capture and full backups
available and pauses history or reaction pagination at a safe boundary. After three
consecutive failed passes the debug channel gets one notice; check the worker log.
