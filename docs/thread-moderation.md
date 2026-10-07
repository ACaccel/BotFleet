# Thread moderation

Nijika enables persistent, bot-scoped moderation in threads, including forum
posts. In the current thread, its creator (`ownerId`), an approved delegated
manager, or a user listed in Nijika's `config.admin` can run:

```text
/thread ban users:@Alice @Bob
/thread allow users:@Alice @Bob
/thread list
```

`users` accepts user mentions or Discord user IDs separated by whitespace or
commas, with at most 20 unique users per invocation. Roles and everyone mentions
are not accepted. Input and authority are checked before the single atomic write;
an invalid target rejects the entire batch. Ban targets must still be guild
members; allow also works after a member leaves. Owners, delegated managers, configured admins and
bots cannot be banned. Discord's Administrator permission alone does not grant
access to these commands. Responses are private and do not ping targets.

`/thread list` shows the current bot's saved ban list for this thread, including
members who have left the guild. It uses the same owner/admin/delegate authorization and
does not require message-deletion permissions. Results include user mentions and
IDs, ordered by ID, with 20 users per page. Use **Previous**, **Next** and
**Refresh** on the private message; the slash command no longer takes `page`.
Only the original requester can operate that message. Each click rechecks
current authority and reads current state; shrinking lists clamp to a valid
page, while revoked authority removes the controls.

A ban combines three restrictions: delete subsequent messages, reject commands
and components, and suppress bot triggers such as automatic replies and link
previews. Autocomplete returns no suggestions and reaction handlers do not run.
The restriction list belongs to this bot and this thread. They persist across
restarts until explicitly allowed. Existing messages are not purged; allowing a
user does not restore deleted messages. Edits from blocked users do not trigger
this bot's message-update subscribers, but do not delete older messages.

## Public replies from other bots

Nijika also deletes public messages from any bot when their origin can be
attributed to a currently banned user in the same thread. This includes other
BotFleet personalities and external apps. Discord interaction metadata identifies
the command or component initiator and takes precedence over reply references.
Otherwise, an ordinary same-thread reply reference can identify the original
author, including through up to three linked replies or saved source records.
Mentions, display names and timing are never used to guess an origin.

Verified banned user messages and their attributable bot replies retain a
source-ID record for seven days, allowing delayed replies to be recognized after
the original message has been deleted. The record stores IDs and expiration,
not message content. Unknown, inaccessible or cross-channel sources are retained;
current ban status is checked again, so allowing a user restores access. Bot
message edits with a verified banned origin are also eligible for deletion.

Nijika cannot intercept another app's command execution or delete private
(ephemeral) responses it cannot see. Bots may execute commands or briefly display
responses before deletion. Responses without reliable origin information remain.

## Delegated management and DM review

A replacement account can request management from any accessible guild channel:

```text
/thread claim thread:<thread> reason:<explanation>
```

The applicant must still be a guild member and able to view the target thread;
private-thread membership is checked when required. Reasons accept 1–1000
characters. Existing owners, admins and delegates do not need to apply. This is
an administrator-reviewed grant, not proof that two accounts have the same owner,
and does not change Discord's `ownerId` or grant access to other threads.

Every distinct user in this bot's `config.admin` receives a DM review card with
the thread link, original owner, applicant, reason and **Approve / Reject**
buttons. No separate review channel is needed. Cards start disabled until their
recipient/channel/message bindings are saved. At least one usable card must be
delivered before the bot reports successful submission. Total delivery failure
closes the request and lets the applicant retry after one minute.
Delivery has a five-minute lease. If the process stops before recording completed
delivery, another request after five minutes closes the abandoned delivery and
starts a new one. A card briefly visible before delivery completion cannot be
approved yet; the admin can retry that button shortly afterward.

Only current configured admins can decide a request, using their own delivered
DM card. Approval rechecks applicant membership, thread access and original
owner, then atomically records the decision, grants management and clears the
applicant's ban in this thread. The first decision wins; replay cannot grant
again. Other cards are disabled on a best-effort basis and remain inoperative
even if editing their display fails. Applicant notifications are also best-effort
and do not undo a saved decision. Delivered cards and grants survive restarts.

Pending requests expire after seven days. One pending request per applicant and
thread is allowed; submissions for that thread are at least one minute apart.
An admin can manage delegates directly:

```text
/thread manager add thread:<thread> user:@Replacement
/thread manager remove thread:<thread> user:@Replacement
/thread manager list thread:<thread>
/thread manager list thread:<thread> page:2
```

These commands are admin-only; owners and delegates cannot delegate further.
Removal works after the user leaves and rejects their outstanding requests, so
old review buttons cannot restore revoked rights. Original owner/admin authority
is unaffected. Grants clear existing thread bans, and delegates cannot be banned
until their delegated management is revoked. The manager list is private, with
20 entries per page. Grant/revoke and review actor/time are retained for auditing.

## Enable and operate

Nijika's configuration example enables the feature:

```json
{
  "thread_moderation": { "enabled": true },
  "commands": ["thread"]
}
```

Merge these commands into the existing list. The block defaults to disabled when
omitted; invalid values fail startup. Enabling it requires `MONGO_URI`. Other
personalities remain disabled unless explicitly configured. Setting `enabled`
to false suspends enforcement without deleting saved restrictions.

Register Nijika's commands and deploy its updated code following
[local setup](contributing/local-setup.md#registering-slash-commands) and
[deployment](contributing/deployment.md). The bot needs access to the thread and
the **View Channel** and **Manage Messages** permissions. A ban command checks
these permissions before saving; allow remains available if deletion permission
has been lost.

Discord threads inherit channel permissions, so this feature deletes messages
after they arrive rather than preventing Discord from accepting them. Messages
may briefly appear or generate notifications. Offline bots cannot enforce bans,
and messages sent while offline are not swept on restart. See Discord's
[thread permissions](https://github.com/discord/discord-api-docs/blob/main/developers/topics/threads.mdx)
and [message deletion permissions](https://github.com/discord/discord-api-docs/blob/main/developers/resources/message.mdx).

If deletion fails, Nijika still suppresses bot triggers and logs the failure.
If the database is unavailable, thread events from ordinary users are suppressed
without deleting messages whose restriction could not be verified; interactions
receive an unavailable response. Owners and configured admins remain exempt.
Delegated authority requires a working database. Restore database access to
resume normal checks. Unverifiable bot replies are retained to avoid deleting
unrelated users' responses.

## Implementation contract

`ClientEventBridge` awaits `ThreadModeration` before message event fan-out,
interaction routing and reaction handling. A moderation plugin in the parallel
event dispatcher would race with replies and is insufficient. Rejected messages
also skip this bot's guild-event attachment cache and update mirrors. Other bot
processes keep their own event handling and restrictions.

The `ThreadModeration` model lives in each guild database and uses a unique
`bot_id/thread_id` index with `blocked_user_ids`, `manager_ids`, embedded claims
and management audit entries. Review decision and grant share one atomic
conditional update, requiring no multi-document transaction. Recipient-bound
message checks, status and expiry are part of the update predicate. Repository reads query current
state without a process-local cache, so separate processes using the same bot ID
observe successful changes on subsequent events. Multi-user updates use atomic
set operations; allowing an unknown thread does not create an empty document.
Already-running handlers are not cancelled by a later ban. Records are retained
when threads are deleted. `ThreadMessageSource` has a unique bot/thread/message
index and a seven-day TTL; lookups reject expired entries immediately, before
MongoDB's asynchronous TTL sweep. Other moderation records are not automatically
deleted.
