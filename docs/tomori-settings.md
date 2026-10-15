# Tomori server settings

Tomori's `/settings` opens a private Discord panel for the current server. Saved
changes take effect without restarting and do not affect another server or bot.
The command is automatically included in Tomori's runtime and registration CLI;
it cannot be disabled through the panel and is unavailable on other personalities.
Register commands with `npm run register -t tomori` before using the new entry.

## Access

Server owners and members with **Manage Server** always have access and recovery
authority. Managers choose an editing audience and delegated categories:

| Audience       | Additional editors                       |
| -------------- | ---------------------------------------- |
| Managers       | None; initial default                    |
| Selected roles | Members holding any selected server role |
| Everyone       | All current server members               |

Everyone edits shared server preferences, not personal settings. Panel grants do
not assign Discord roles or grant Discord permissions. Discord integration-level
command restrictions still apply; repair those in Server Settings > Integrations
if `/settings` is hidden.

Managers alone change access rules, destination channels, moderation, logging,
preview message deletion and preview-count ceilings. Delegation covers automatic
replies, social-preview preferences, and activity/giveaway/temporary-role/
entertainment/report feature switches and scopes. Actual feature use retains its
existing Discord, creator and operator authority checks. Entertainment has a master feature switch plus individual command switches and
per-member cooldowns. General language/time-zone and moderation-vote parameters
remain manager-only.

Role removal and category revocation invalidate permission to save existing
drafts. Deleted editor roles never open access to everyone. Managers can repair
them. Access changes require a separate save from preference changes.

## Panel controls

| Category          | Available controls                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| General           | Public response language and IANA time zone; managers only                                                                 |
| Entertainment     | Individual command switches and per-member cooldowns                                                                       |
| Moderation votes  | Threshold, window, default timeout and voter roles; managers only                                                          |
| Access            | Form for audience, editor roles and delegated categories; managers only                                                    |
| Features          | Inline master switches; a scope form selects all/selected channels and exclusions                                          |
| Channels          | One form for command-log, event-mirror and default giveaway destinations; managers only                                    |
| Automatic replies | Keyword, targeted lucky, random, dice and reaction switches; random percentage and cooldown seconds                        |
| Social previews   | Allowed provider subset, video download opt-out, original embed strategy; managers also control deletion and preview count |
| Status            | Effective capabilities, missing destination permissions and storage notice                                                 |
| History           | Recent configuration revisions and changed field names, filtered by editing authority                                      |

General, access, output destinations, automatic replies, social previews and
moderation preferences use forms. Feature master switches stay inline; **Edit
scope** opens a form for that feature's inclusion/exclusion rules. Entertainment
has a command selector and individual switch/cooldown controls.

Open **Edit parameters** on the Automatic replies or Social previews page to
change its values, submit the form, then choose **Save** on the panel. Reply
behaviors and providers allow an empty selection to disable all entries.
The preview-count field shows the actual deployment-constrained range: integer
`1` through `min(5, social_link_preview.maxUrlsPerMessage)`. This counts successful
Tomori URL previews from one message, rather than restricting posted links. Optional
modal multi-selects explicitly use `required: false` with `min_values: 0`, as required
by the [Discord component contract](https://docs.discord.com/developers/components/reference#string-select-string-select-structure).

Changes are drafts until **Save**. **Preview** shows differences; **Discard** or
**Reload** restores the latest committed settings. Switching categories preserves
the draft. A conflicting save retains the draft and asks the editor to reload
before editing again. Drafts expire after ten minutes and are lost on restart.
Save failures never imply success; an uncertain database acknowledgement remains
pending until the stored operation can be reconciled.

Unapplied retries recheck the original editor's current membership, grants and
resource access. Revoked authority cancels the retry with a revision-only update
that fences the old operation; already committed writes are simply synchronized.

Channel exclusions inherit through categories and parent channels/threads and
win over selected-channel inclusion. Static permission-rank restrictions still
apply. Selected resources must belong to this server and be visible to the
editor; destinations require the bot's View Channel, Send Messages and Embed
Links permissions. Missing/deleted destinations stop that output. Native channel
selectors support text and announcement destinations; scope selectors also
support categories, forums, media/voice channels and threads.

Feature switches cover slash commands, context menus, relevant modals/buttons,
and automatic message events. Creating an activity, giveaway or temporary role
can be disabled while existing participation, closure, drawing, expiry and
cleanup continue. Thread disable preserves existing blocked-member enforcement
and unblock/rejection paths; it prevents new claims, bans, manager grants and
approval of pending claims. Reports disabled also block leaderboard pagination.
Signed `/talk` and configured giveaway creation must pass the actual destination
scope as well as the invoking channel scope.

Automatic-reply cooldowns are per server/channel, reserved before the first
matching send, and protect concurrent events. Unmatched messages consume no
cooldown; attempted sends that fail still consume one. State resets on restart.
Targeted operator lucky replies require an explicit `guildId` on Tomori; unbound
entries are withheld. Other personalities retain their existing behavior.

Social providers and preview counts cannot exceed deployment capabilities.
Disabling videos skips download/attachment work while preserving static preview
cards and source links. Members may switch between keeping and suppressing the
original embed; transitions involving original-message deletion require a manager.

## General preferences

Managers choose the public response language (`en`, `zh-TW`, or deployment
inheritance) and an IANA time zone such as `Asia/Taipei`, `America/New_York` or
`UTC`. A blank time-zone input inherits deployment configuration; unsupported
zones are rejected. Guild report calendars and activity date interpretation use
this effective zone. Inheritance is the default for existing and new records.

Interactions, guild events and scheduled jobs resolve their source guild through
an asynchronous context; concurrent guilds never mutate a shared locale or zone.
Scheduled callbacks resolve saved preferences again at execution. Private
`/settings` pages and forms still follow the editor's Discord locale. Generic DMs
without a source guild inherit deployment preferences.

## Entertainment preferences

The entertainment master feature and scope must allow a command before its
individual switch is considered. Separate controls cover `/gay`, `/give_score`,
`/random_restaurant`, and the author-avatar, avatar, sticker and score context
menu commands. Cooldowns are integer seconds from `0` to `86400`, per guild,
member and command; `0` disables the cooldown. Every command starts enabled with
no cooldown. A reservation precedes dispatch and failed attempts consume it.
State is bounded in memory, isolated per application and reset on restart.
Changing the cooldown does not clear an existing reservation. Editors delegated
the entertainment category may adjust these preferences.

## Moderation-vote preferences

Only managers may configure:

| Preference      | Accepted values                                          | Default                          |
| --------------- | -------------------------------------------------------- | -------------------------------- |
| Required votes  | Integer 2-50                                             | 5                                |
| Voting window   | Integer 10-600 seconds                                   | 60                               |
| Default timeout | Integer 1-5 minutes                                      | 1                                |
| Voter roles     | Up to 25 current server roles; any listed role qualifies | Empty: all current human members |

An explicit `/ban_user duration` overrides the default within the existing
1-5 minute command bounds. Configured roles are the only allowed role mentions;
empty eligibility pings nobody. Tomori does not use the legacy `roles.ban_user`
ping mapping for these new controls.

The poll displays its chosen threshold, window and duration. Reaction users are
fetched in pages and membership/roles are fetched afresh at judgement; bots,
departed members and users without a required role do not count. Failed reads do
not authorize punishment. Existing polls retain their starting parameters;
disabling the feature or changing its voter-role policy cancels pending punishment. Targets must remain moderatable
by the bot at creation and judgement. Discord refusal applies no alternative
punishment in Tomori; other personalities retain their prior fallback behavior.
Votes and their scheduled judgements remain in memory and do not survive restart.

## Defaults, migration and recovery

At first startup, persist a fixed inventory of already joined servers. These
servers receive a one-time seed of their current feature behavior and static
channel maps; targeted lucky replies still require guild binding. Later joins
receive safe defaults: interactive features are available, while automatic
replies, social previews, event mirroring, command logs and moderation votes
start off. Destinations are unset and editing is manager-only. New automatic
reply preferences start at 0.5% with a five-second cooldown, subject to operator
bounds.

Initialization copies supported preferences into MongoDB; it never edits or
removes `config.json`. Existing persisted records always win over the legacy
seed, including after a restart:

| Setting source                                                               | Authority after initialization                                                |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `guilds.<guildId>.channels.debug`, `.event`, `.giveaway`                     | Seeded once; edit subsequent destinations in `/settings`                      |
| Feature switches/scopes, editor grants and panel parameters                  | Per-server database record; defaults and supported legacy values seed it once |
| `guilds.<guildId>.roles`, permission ranks and other unexposed configuration | Still read from deployment configuration; not copied into panel settings      |
| Secrets, provider endpoints, installed commands and operator ceilings        | Still deployment-controlled; the panel cannot override them                   |

Configuration changes after seeding do not overwrite saved server preferences.
Operator capability changes still restrict effective behavior. A missing
database/settings snapshot stops policy-dependent outputs rather than reverting
to permissive defaults. Failed loads and pending writes retry using
`MONGO_RECOVERY_INTERVAL_MS`; unaffected servers continue operating.

Settings are stored in each server's database with an application-ID key. The
fixed migration inventory uses the application ID as a reserved control database
suffix under the same Mongo URI prefix. Include that database in backups and
grant the deployment account access. It contains configuration metadata, not
messages. Version-1 documents upgrade to version 2 on read with a schema/version/revision
compare-and-swap. Missing sections receive compatibility defaults; existing
preferences, revision and history are retained. A concurrent user save wins over
a stale upgrade. Unknown versions fail closed. The repository maintains a unique
application/server index, schema version, revision and the latest 50 atomic audit entries (actor/time/field names).
No custom reply text, interaction tokens or message content enters this history.

Leaving a server clears runtime snapshots and drafts but retains persisted
settings for rejoin. Rejoining reloads settings and revalidates resources before
use. One process per Tomori application is supported; concurrent replicas need
separate cache-invalidation work.

## Output versus storage

Disabling event mirroring or command-log output does **not** stop host audit logs,
attachment caching/archiving or message-archive collection. The panel reports
this distinction and never deletes historical data. Operator-only settings
remain in deployment configuration: secrets, external endpoints/proxies, global
identity, bug-report hub, storage retention and hard resource limits. Tomori does
not compose AI chat; this panel cannot enable it.

## Planned extensions

Tracked next-stage work for this feature:

- Optional setup wizard and activity/giveaway/temporary-role defaults.
- Guild-bound lucky-reply content editing and narrower feature-use role policies.
- Dynamic privacy-rank editing and true per-guild collection/retention controls.
- Cross-process snapshot invalidation before supporting multiple replicas.

These controls are not shown as functional editors in the current panel.
