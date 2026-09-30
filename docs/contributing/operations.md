# Operations

Part of the [contributing guide](../../CONTRIBUTING.md). For service commands
and rollback, use [deployment](deployment.md).

## Host migration

The [migration runbook](../../tools/migration/README.md) owns host setup,
database transfer, runtime validation, and cutover instructions.

## Recording removal rollout

Follow the [recording removal checklist](../upgrading.md#recording-removal-rollout)
when upgrading an older deployment.

## Pre-deploy smoke

The live smoke check requires a real bot `.env` and network access:

```bash
npm run smoke                     # defaults to nijika
npm run smoke -- --bot konata
SMOKE_TIMEOUT_MS=60000 npm run smoke -- --bot tomori
```

It validates environment values, runs authenticated MongoDB `admin.ping`
when `MONGO_URI` is set, then logs in to Discord and verifies the ready user
matches `CLIENT_ID`. Each step defaults to a 30-second timeout. Exit status
is `0` for success or `1` with the failed step reported.

The check does not register commands, start plugins, or open HTTP routes;
passing it does not establish application-level health. Run it before
promoting a release, separately from CI.

## Temporary moderation

`/ban_user` attempts a Discord timeout after a successful vote. If Discord rejects
the timeout, including for an administrator, the bot deletes the target's messages
for the requested duration and suppresses its automatic replies to those messages.
This covers both configured auto-replies and self-hosted LLM auto-replies, even
when deleting a message fails. Replies become eligible again when the duration
expires.

The fallback applies only to the target user in the command's guild and to the
bot that handled the command. Other bot processes do not share the restriction.
Fallback state is held in memory; restarting that bot ends the deletion and
auto-reply restriction early. Native Discord timeouts remain managed by Discord.

## Dependency overrides

The `undici: ^6.27.0` override fixes the vulnerable exact version pinned by
`discord.js`. Recheck it on every Discord dependency upgrade and remove it
when the upstream version includes the fix. Use `npm explain <pkg>` before
adding overrides; do not restate a version the dependency already permits.

## Database recovery

Transient connection failures and timeouts are retried in the background
after startup/onboarding retries are exhausted. `MONGO_RECOVERY_INTERVAL_MS`
controls polling and per-guild cooldown; see the
[configuration reference](../configuration.md). Authentication, authorization,
and other persistent failures require fixing the cause and restarting.

Recovery reattaches repositories and rebuilds guild-scoped jobs only for the
recovered guild. Match the database error ID in giveaway failures to connection
logs. A refused TCP connection requires restoring MongoDB or its network route;
restarting the bot alone cannot fix it.
