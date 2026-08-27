# First-Boot Setup Wizard — design plan (not yet built)

**Status: planned, not implemented.** This document captures a design worked
out in conversation, for a future session to build. Nothing described here
exists in the codebase yet — `/recruit-setup` (the manual command) is still
the only way setup actually happens today.

## The problem this solves

Two related gaps, both already found and reasoned through:

1. **A clan leader has to know `/recruit-setup` exists and type it.** There's
   no prompt, no discovery — if they don't read the docs, nothing happens
   after the bot joins.
2. **`/recruit-setup` always creates its own channels/roles fresh**, even
   when an already-established clan already has an equivalent — most
   commonly their own general chat channel and their own `leaders`/`officer`
   role. Today, adopting an existing one instead requires manually editing
   `config/recruit.config.json` and copying a Discord channel/role ID via
   Developer Mode — a real technical barrier for exactly the non-technical
   clan leaders this project is built for.

## Scope: which existing channels/roles are actually worth adopting

Checked directly against the 9 roles and full channel list `/recruit-setup`
creates — most have no real-world equivalent an existing clan would already
have (`kraken-member`, `kraken-warcore`, `kraken-underwatch`, `probation`,
`on a break`, `remove`, `waitlist`, `new-arrival` are all KRAKEN-specific
tier/state concepts with no clean 1:1 mapping to some pre-existing informal
role). Only three things are common enough, with a clean enough 1:1 real-world
meaning, to be worth an adoption option:

1. **Existing general/chat channel** → maps to `channels.memberChatChannelId`
   (config override already exists today, just not exposed as an in-Discord
   picker).
2. **Existing leaders/officers chat channel** → maps to
   `channels.leadersChatChannelId` (same — override already exists).
3. **Existing leaders/officers role** → maps to `roles.leadersRoleId` (same).

## Two real risks that must be surfaced, not silently applied

- **Chat channel timing risk (existing, already-active servers only):**
  pointing KRAKEN at a clan's real, currently-open chat channel and locking
  it to `kraken-member`+`leaders` immediately would lock out every real
  member who hasn't relinked yet — before they've had a chance to. This is
  only safe to do once the relink rollout is substantially complete (most of
  the roster already holds `kraken-member`). Not a concern for a genuinely
  fresh server with nobody in it yet.
- **Leaders-role permission-stripping risk:** every KRAKEN-managed role has
  its own server-wide permissions zeroed out on every `/recruit-setup` run
  (access control lives entirely in channel overwrites, not the role —
  confirmed elsewhere in this codebase). If an operator adopts an existing
  "Officer" role that already has real server-wide permissions attached
  (Kick Members, Manage Messages, etc.), those get stripped. This needs its
  own explicit warning, separate from the timing warning above.

Both warnings need to live in the wizard UI itself, at the point of choice —
not buried in a doc the operator may never read.

## The proposed UI: one message, multiple select menus, a Confirm button

A single Discord message, sent via DM (see trigger timing below), containing:

```
👋 I'm KRAKEN — let's get your clan set up.

[ Existing chat channel? (leave blank to create fresh)     ▾ ]
[ Existing leaders chat channel? (leave blank to create)   ▾ ]
[ Existing leaders role? (leave blank to create fresh)     ▾ ]

        [ Confirm & Set Up ]        [ Start Fresh ]
```

- Two `ChannelSelectMenuBuilder` rows + one `RoleSelectMenuBuilder` row +
  one button row = 4 action rows, within Discord's 5-per-message limit.
- Each select's placeholder/description text carries the relevant warning
  from above, visible at the point of choice.
- **Mechanically**: each select menu fires its own interaction the instant
  something is picked — Discord does not batch multiple selects into one
  submission. The handler must update the same message in place each time
  (quietly recording the pick without visibly changing anything else) and
  only actually run setup logic once **Confirm & Set Up** is clicked. Until
  that click, nothing is created or touched — this needs a small piece of
  temporary state tied to the message/interaction, not a one-shot form
  submission.
- **Start Fresh** is a shortcut equivalent to clicking Confirm with all
  three selects left blank — today's existing `/recruit-setup` behavior.

This reuses the existing self-service-panel pattern already used everywhere
else in this codebase (welcome/break/appeals/waitlist panels) rather than
inventing a new interaction style.

## Trigger timing — corrected during design, worth getting right

**Not** Discord's `GuildCreate` event ("bot just joined a server"). Checked
directly: in every onboarding path this project uses (the manual `SETUP.md`
walkthrough and `scripts/provision-clan.mjs`), the bot is invited into the
guild **before** it is ever started running for the first time —
`setup-check` explicitly requires bot-guild-membership to already be true
before `npm start`/`pm2 start` ever runs. So by the time the bot actually
joins, there is no running process to receive a live gateway event at all.

**Correct trigger: the bot's own first-ever `ClientReady`.** This is the
first real moment KRAKEN can do anything (including sending a DM). Detect
"first ever boot, never configured" via the existing signal already used
elsewhere in this codebase: no stored channel IDs
(`channels.welcomeChannelId` / its `#link-account` successor) yet in
`recruit_settings`. If that's genuinely the first boot, DM the guild owner
the wizard immediately as part of the existing `ClientReady` handler
(alongside `ensureWelcomePost`/`ensureRelinkPost`). If the clan has already
been configured before (a normal restart), skip it entirely.

## How this lines up with the invite link + provisioning flow

Two separate actions, not one automatic chain, but they happen close
together in practice:

1. **The clan leader clicks the invite link** (built and sent to them by the
   operator, or generated interactively by `scripts/provision-clan.mjs`) —
   this adds the bot to their server. Instant, needs nothing further from
   the operator at that exact moment.
2. **The operator starts the bot process for the first time** — via
   `provision-clan.mjs` finishing its run (which already pauses right after
   printing the invite link, waits for operator confirmation the bot joined,
   then proceeds through `setup-check` → `deploy-commands` → RAM check →
   final confirmation → `pm2 start`, all in one session), or manually via
   `npm start`/`pm2 start` in the `SETUP.md` walkthrough.
3. The moment that process comes online for the first time, `ClientReady`
   fires, detects "never configured," and DMs the wizard.

From the clan's actual experience this feels close to instant (they click
the link, then within however long it takes the operator to finish the
provisioning run, they get a DM) — but it is technically gated on the
operator completing their side, not purely automatic from the invite click
alone.

## What still needs deciding before implementation

- Exact wording for both warnings (timing risk on the chat channel select,
  permission-stripping risk on the leaders-role select).
- What happens if the DM fails (owner has DMs from non-friends disabled) —
  `/recruit-setup` should remain the manual fallback path regardless.
- Whether "Start Fresh" should require its own confirmation step, or fire
  immediately given it's already the safe, well-tested default behavior.
