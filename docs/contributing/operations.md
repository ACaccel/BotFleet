# Operations

For service commands and rollback, see [deployment](deployment.md).

For X accounts and Bahamut board/thread subscriptions, target URLs, cursor
recovery and command registration after upgrades, see
[feed configuration](../configuration.md#bahamut-subscriptions).

For `/gay` archive inputs, daily score persistence and fallback behavior, see
[daily fun readings](../fun-readings.md). No archive setup is required to use its
basic reading; score snapshots expire automatically.

## Command logs

For Tomori and Nijika per-server destinations, feature scopes, permission recovery and
settings database failures, see [server settings](../tomori-settings.md). Reboot
notices use the saved debug destination; the command-log feature switch controls
command embeds, while a configured debug destination also receives system notices.
Public language/time-zone edits apply to subsequent guild work, including
scheduled execution. A process restart clears entertainment cooldowns and
in-memory moderation polls; their settings remain persisted.

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

## Database backups

`pleiades-mongo-backup.timer` dumps every application database daily into
`/var/backups/pleiades` and keeps 3 snapshots. Install, check and restore steps are in
the [backup guide](../../tools/mongo-backup/README.md).

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

## Notification relay

To enable konata's [notification relay API](../configuration.md#notification-relay-api):

1. Generate a key with `openssl rand -hex 32`.
2. Add `NOTIFY_API_PORT=<port>` and `NOTIFY_API_KEY=<key>` to `src/bot/konata/.env`.
   Pick a free local port that no other bot uses (nijika's `EARTHQUAKE_ALERT_PORT`,
   for one). Give the same key to the calling service through its own secret store,
   never through Git.
3. Add the route to `notificationRoutes` in `src/bot/konata/config.json` and make
   sure konata can view, post and embed links in that channel.
4. Deploy konata with `npm run deploy -t konata` (see [deployment](deployment.md#commands)).
   Preparation rejects a port without a key of at least 32 characters and a
   malformed route block.
5. Check the startup line `notification relay API is listening on 127.0.0.1:<port>`
   in `journalctl -u pleiades@konata.service`.

The API listens on `127.0.0.1` only. To rotate the key, change both sides and
redeploy konata; to disable it, remove `NOTIFY_API_PORT` and redeploy.

## Earthquake alerts

To enable Nijika or Tomori's [early-warning API](../configuration.md#early-warning-api) for the
地牛Wake Up! app on a Windows machine in the same tailnet:

1. Generate a key with `openssl rand -hex 32`.
2. In `src/bot/nijika/.env`, remove the retired `PORT` and add
   `EARTHQUAKE_ALERT_PORT=4000` and `EARTHQUAKE_ALERT_KEY=<key>`. Any free local port
   works; use the same port in the `tailscale serve` step.
3. Optionally set the role-ping threshold in `src/bot/nijika/config.json`, for example
   `"earthquake_alert": { "ping_min_local_intensity": "5-" }`; without it the role is
   pinged from local intensity 4 (see
   [the configuration reference](../configuration.md#early-warning-api)).
4. Publish the API to the tailnet only (HTTPS, prefix stripped), then check the
   mapping with `tailscale serve status`. Its output shows the full URL,
   `https://<server>.<tailnet>.ts.net/earthquake/`; the Windows caller needs that URL
   with `alerts` appended:

   ```bash
   sudo tailscale serve --bg --set-path /earthquake/ http://127.0.0.1:4000
   ```

5. Deploy nijika with `npm run deploy -t nijika` (see [deployment](deployment.md#commands)).
   Preparation rejects a port without a key of at least 32 characters and a malformed
   `earthquake_alert` block. Check the startup line `earthquake alert API is listening on 127.0.0.1:4000` in
   `journalctl -u pleiades@nijika.service`.
6. On Windows, install the scripts, the `earthquake-alert.config.json` holding
   `https://<server>.<tailnet>.ts.net/earthquake/alerts` and the key file, and point the app at
   `earthquake-alert.cmd` as described in
   [the Windows guide](../../tools/earthquake-alert/windows/README.md), then press the
   app's test button. A `result=test` request in nijika's log, and a success box on
   Windows, confirm the whole path without posting to Discord.

For Tomori, use its own `.env`, unused local port, proxy path and caller key/URL
instead of the Nijika values above, then deploy with `npm run deploy -t tomori`.
Set `CWA_API_KEY` for reports. In Tomori's `/settings` > **Earthquake notifications**,
select a destination and enable each required feed; the warning role may be empty.
Both feeds start off on every server, and CWA reports never mention anyone.
Use separate caller/proxy routes when both bots receive warnings.

To rotate the key, change `.env` and the Windows key file, then redeploy the selected bot; to
disable the API, remove `EARTHQUAKE_ALERT_PORT`, redeploy, remove the serve path with
`sudo tailscale serve --set-path /earthquake/ off` and confirm with
`tailscale serve status`.

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
other persistent failures, then restart the bot. To recover lost or corrupted data,
restore a [daily backup](../../tools/mongo-backup/README.md#restore).

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
