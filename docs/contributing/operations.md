# Operations

For service commands and rollback, see [deployment](deployment.md).

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
jobs, reviewed repair and conditional rollback through `/archive` in the configured
guild debug channel. Local tests do not authorize production repair. Unrelated
collection cleanup remains in the [database CLI](../../tools/db/README.md);
whole-database transfer remains in the [migration runbook](../../tools/migration/README.md).

For normal one-shot work, use the [guided backup flow](../message-archive.md#one-shot-repair).
Its public status card updates every ten seconds and offers **View details** and
cooperative stopping. The changes view shows small plans directly and groups
larger plans with source examples. Pages use buttons only, with at most five
controls. `/archive jobs` and `/archive plans` show two items per page; select an
item button or use refresh/next-page navigation. **Delete all jobs** and
**Delete all plans** open an all-pages review before confirmation. Item panels offer eligible delete
and rollback buttons directly. Stop a running job before deleting its record.
Apply, resume and acceptance open confirmation on the selected item's panel.
Use the same panel's item, refresh and list buttons to navigate without comparing
separate messages. Other panels retain their current view. The original job card
shows actual current activity every ten seconds; a running job opened in a list
panel uses **Refresh** to retrieve a new snapshot.
There are no active-only filters, technical pages or nested change drilldowns.
Unused plans can be deleted before application or after a complete rollback when
no conflicts, recovery journals or active work remain. Single and bulk deletion
use the same checks and preserve archived messages.
See the [deletion rules](../message-archive.md#discord-controls) for protected
recovery data and [bulk deletion](../message-archive.md#bulk-deletion) for snapshot
review, cooperative job stopping and durable result/resume controls.

Periodic scans are disabled until explicitly enabled per guild. Use
[`/archive schedule enable minutes:60`](../message-archive.md#periodic-schedule)
after the one-shot repair is accepted to save an interval and enable scanning in
one command. Repeating saved settings preserves the next due time. Disabling it
leaves live capture and control jobs available and pauses history or reaction
pagination at a safe boundary.
