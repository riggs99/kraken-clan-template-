# KRAKEN — Setup Guide

Getting one clan's KRAKEN instance from nothing to a working bot. If you're
running instances for **many** clans off one host, do this once per clan, then
see [docs/multi-clan-hosting.md](docs/multi-clan-hosting.md) for the pm2/host
side.

The whole flow is: **create a bot → invite it → get a CR API key → fill in
config → verify → start → `/recruit-setup` → members join.** Budget ~15
minutes.

---

## What you need first

- **Node.js v20+** on the machine that will run the bot.
- A **Discord account** with permission to add a bot to the target server (you
  own it, or the owner will run the invite link).
- A **Clash Royale account** for the developer API (developer.clashroyale.com).
- The **clan tag** (e.g. `#ABC123` — you'll use it without the `#`).

---

## Step 1 — Create the Discord bot

1. Go to <https://discord.com/developers/applications> → **New Application**,
   name it for the clan.
2. **Bot** tab:
   - **Reset Token** → copy it. This is `DISCORD_TOKEN`. Treat it like a
     password — it only goes in `.env`, never in chat or a commit.
   - **Privileged Gateway Intents** → turn **Server Members Intent** ON. The
     bot won't start without it. (Leave Presence and Message Content OFF — the
     bot doesn't use them.)
   - **Public Bot** → turn it **OFF**. Each clan gets its own dedicated bot;
     there's no reason for anyone else to be able to install it.
3. **General Information** tab → copy the **Application ID**. This is
   `DISCORD_APP_ID`.

---

## Step 2 — Invite the bot to the server

1. **OAuth2 → URL Generator**:
   - **Integration type:** Guild Install.
   - **Scopes:** `bot` and `applications.commands`.
   - **Bot permissions:** Manage Roles, Manage Channels, Send Messages, Embed
     Links, Read Message History, Manage Messages.
2. Open the generated URL, pick the clan's server, authorize.
3. **Position the bot's role high.** In Server Settings → Roles, the bot's role
   must sit **above every role it manages** — including `leaders`. On a fresh
   server this happens automatically (KRAKEN creates its roles *below* the bot),
   so usually there's nothing to do. It only matters if you re-invite the bot
   later or hand-edit the role order — see [Role hierarchy](#role-hierarchy)
   below. `/recruit-setup` warns you if anything's out of place.

Grab the **server ID** too: with Developer Mode on (User Settings → Advanced →
Developer Mode), right-click the server icon → Copy Server ID. This is
`DISCORD_GUILD_ID`.

---

## Step 3 — Get a Clash Royale API key

1. Go to <https://developer.clashroyale.com>, log in, **Create New Key**.
2. **Whitelist IP:** the bot talks to Supercell through the RoyaleAPI proxy by
   default (`CR_API_BASE=https://proxy.royaleapi.dev`), so the key must be
   bound to the **proxy's** IP, **not** your own:

   ```
   45.79.218.79
   ```

   (Using the proxy is why you *don't* need a static IP of your own. If you
   ever switch `CR_API_BASE` to hit Supercell directly, you'd whitelist your
   host's real public IP instead.)
3. Copy the key → this is `CR_API_TOKEN`. Note the **clan tag** while you're
   there.

---

## Step 4 — Fill in the config

From the project folder:

```bash
npm install
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
```

Edit **`.env`** and fill in the required values:

| Variable | Value |
|---|---|
| `DISCORD_TOKEN` | Bot token from Step 1 |
| `DISCORD_APP_ID` | Application ID from Step 1 |
| `DISCORD_GUILD_ID` | Server ID from Step 2 |
| `CR_API_TOKEN` | API key from Step 3 |
| `CLAN_TAG` | Clan tag **without** the `#` |

`CR_API_BASE` is already set to the proxy — leave it. `LEADER_CHANNEL_ID` is
optional (where scheduled reports post); every other var has a sane default and
is documented inline in `.env.example`.

Edit **`config/recruit.config.json`** — replace the `PUT_*` placeholders:
- `recruitGuildId` → your server ID (same as `DISCORD_GUILD_ID`)
- `clanName` → the clan's display name
- `warServer.inviteUrl` → an invite link to the server

Edit **`config/ops.config.json`**:
- `opsGuildId` → your server ID

The bot refuses to start while any `PUT_*` placeholder remains — that's a guard,
not a bug.

---

## Step 5 — Verify before you start

```bash
npm run setup-check
```

This runs a real pre-flight check: required `.env` values, no leftover
placeholders, the Discord token actually logs in, the bot is in the server with
the right permissions, the CR API key + clan tag work together, the database is
writable, and the leader channel resolves. Every line should read `[OK]`. Fix
anything that fails (each failure prints an exact remedy) and re-run until it's
all green. It's safe to run as many times as you like.

Common failures:
- **CR API 403** → the key isn't whitelisted for `45.79.218.79` (see Step 3).
- **Bot not in server** → the invite (Step 2) didn't complete.
- **Placeholders remain** → a `PUT_*` value is still in a config file.

---

## Step 6 — Register commands and start

```bash
npm run deploy    # registers the slash commands to your server
npm start         # starts the bot
```

You want a clean startup with no errors, ending in:

```
🐙 KRAKEN ONLINE as <your bot>#0000
```

For 24/7 operation under a process manager, see
[docs/multi-clan-hosting.md](docs/multi-clan-hosting.md).

---

## Step 7 — Run `/recruit-setup` in Discord

In the server, as the **owner or an admin**, run `/recruit-setup` once. It
builds the entire Recruit HQ automatically:

**Channels**
- `#welcome` — the only channel visible to everyone, including a
  just-joined `new-arrival` who hasn't applied yet — public landing + the
  "Agree & Join" onboarding panel
- `#kraken-decisions` — members-only (`kraken-member` + `leaders`),
  member-facing decision summaries
- `#on-a-break` — members-only (`kraken-member` + `leaders`), break-request
  panel
- **leaders** category (leaders-only): `#kraken-decisions-leaders` (full
  internal decision log), `#kraken-ops`, `#logs`, `#removal-queue` — these
  are all bot-managed data/log surfaces, not a place to actually chat
- Member chat (optional, adopted by name-match on a channel called
  `general`, or set explicitly via `channels.memberChatChannelId`) —
  members-only (`kraken-member` + `leaders`)
- Leaders chat (optional, adopted by name-match on `leaders-channel` /
  `leaders-chat`, or set explicitly via `channels.leadersChatChannelId`) —
  a plain leaders-only chat space, separate from the leaders category above
- Waiting list (optional, adopted by name-match on `waiting-list` /
  `waitlist`, or set explicitly via `channels.waitingListChannelId`) —
  read-only queue panel; also gates in the `waitlist` role (`roles.waitlistRoleId`)
  once it exists, but that role itself still isn't created automatically

`kraken-member` is granted to everyone the moment `/apply` succeeds,
regardless of tier — so a `new-arrival` who hasn't applied, or someone
sitting on the waitlist, sees only `#welcome` until they're actually in.

Every KRAKEN role's own server-wide permissions (Server Settings → Roles →
Permissions) are also zeroed out automatically on every run — all real
access control lives in the channel overwrites above, never on the role
itself. The bot's own role is the only exception; see
[Role hierarchy](#role-hierarchy) below.

**Roles** (created below the bot, in display order): `leaders`,
`kraken-warcore`, `kraken-member`, `kraken-underwatch`, `probation`,
`on a break`, `new-arrival`, `remove`. The standing roles are hoisted so
members group by their standing in the sidebar.

It stores every channel/role ID in SQLite, so it's **safe to re-run** — it
reuses what it already made (by ID, not name) and never creates duplicates. If
any managed role has drifted above the bot, the completion message tells you
exactly which role to move.

---

## Step 8 — Members join

- **Existing members:** `/relink` with their player tag — keeps their standing,
  no re-join needed.
- **New recruits:** `/apply` (or the "Agree & Join" button in `#welcome`) with
  their player tag. KRAKEN verifies the tag against the live clan roster, starts
  tracking them, and grants `kraken-member` + `probation`.
- **In-game co-leaders / leaders:** automatically also get the `leaders` role
  when they apply (detected from their clan rank via the CR API) — provided the
  `leaders` role sits below the bot. Everyone still follows the normal tier
  rules afterward. The owner can always add/remove `leaders` by hand; KRAKEN
  reads the role live and respects it.

See [docs/commands.md](docs/commands.md) for the full command reference.

---

## Role hierarchy

KRAKEN can only assign roles positioned **below its own role** — Discord forbids
a bot from touching its own role or anything above it. So the standing
arrangement is:

```
  <your bot's role>        ← must stay on top of the block below
  leaders                  ← so the bot can auto-grant it to new leaders
  kraken-warcore
  kraken-member
  kraken-underwatch
  probation
  on a break
  new-arrival
  remove
```

`/recruit-setup` creates and orders these automatically. The one thing to know:
**if you re-invite the bot**, Discord recreates its role at the *bottom*, below
all the roles from the earlier setup — which silently breaks role granting.
If that happens, drag the bot's role back above the block (or just re-run
`/recruit-setup`, which will warn you and re-order what it can). Note KRAKEN
can't drag its own role up — that one step is always a human's.

---

## Troubleshooting

- **"Config incomplete: replace all PUT_* placeholders"** — a config file still
  has a placeholder. Re-run `npm run setup-check` to see which.
- **Role grant failed / a role isn't being assigned** — the role is above the
  bot. See [Role hierarchy](#role-hierarchy).
- **CR API 403** — the key isn't whitelisted for the proxy IP `45.79.218.79`.
- **Bot won't start, "Missing required environment variable"** — a required
  `.env` value is blank. `npm run setup-check` lists them.
- **Commands don't appear in Discord** — run `npm run deploy`, give Discord a
  minute, and confirm `DISCORD_GUILD_ID` matches the server.

Re-running `npm run setup-check` is the fastest way to locate almost any setup
problem — it checks the live state and prints a specific fix for each failure.
