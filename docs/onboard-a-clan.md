# Onboarding a New Clan

The repeatable runbook for adding a clan to a host already running KRAKEN
instances (e.g. the `kraken-host` VPS) — follow this every time a clan wants
in. For getting the *first* instance and the VPS itself set up, see
[SETUP.md](../SETUP.md) and [multi-clan-hosting.md](multi-clan-hosting.md)
instead; this doc assumes that part is already done.

## What to send a clan that replies

> *"Awesome, keen to get you set up! I just need two things from you:*
> *1. Your clan tag (e.g. #ABC123)*
> *2. Your Discord server ID — turn on Developer Mode (User Settings →
> Advanced → Developer Mode), then right-click your server icon → Copy
> Server ID*
> *Send those over and I'll have it running for you within the day. You'll
> just need to click an invite link and run one command once it's ready —
> I'll walk you through it."*

## The runbook

**① Get from the clan**
- [ ] Clan tag
- [ ] Discord server ID

**② Create their bot** — [discord.com/developers/applications](https://discord.com/developers/applications)
- [ ] New Application → name it
- [ ] Bot tab → Reset Token → copy (`DISCORD_TOKEN`)
- [ ] Bot tab → **Server Members Intent ON**, **Public Bot OFF**
- [ ] General Information → copy **Application ID**

**③ Build the invite link** — same page, OAuth2 → URL Generator
- [ ] Guild Install, scopes `bot` + `applications.commands`
- [ ] Permissions: Manage Roles, Manage Channels, Send Messages, Embed
      Links, Read Message History, Manage Messages
- [ ] Copy the URL → **send it to the clan**

**④ They invite the bot**
- [ ] They click your link, pick their server, authorize

**⑤ SSH into the VPS and set up their folder**
```bash
ssh root@<vps-ip>
cd /root/clans
git clone https://github.com/riggs99/kraken-clan-template-.git clanN
cd clanN
npm install
```
*(bump the number for each new clan — `clan2`, `clan3`, etc.)*

**⑥ Fill in `.env`**
```bash
cp .env.example .env
nano .env
```
`DISCORD_TOKEN`, `DISCORD_APP_ID` → from step ②. `DISCORD_GUILD_ID` → their
server ID. `CR_API_TOKEN` → generate a **new, separate key** for this clan at
developer.clashroyale.com (whitelisted to the same proxy IP, `45.79.218.79`,
as every other clan's key) — see `multi-clan-hosting.md` for why: Supercell's
rate limit is per-key, so sharing one key across clans means they'd all share
one rate-limit budget and could all start failing at once as you add more.
Keys are free, so there's no reason not to give each clan its own. `CLAN_TAG`
→ theirs. Save: Ctrl+O, Enter, Ctrl+X.

**⑦ Fill in the config files**
```bash
nano config/recruit.config.json
```
`recruitGuildId` → their server ID, `clanName` → their clan's name,
`warServer.inviteUrl` → an invite link to their server. Save/exit.
```bash
nano config/ops.config.json
```
`opsGuildId` → their server ID. Save/exit.

**⑧ Verify — must be 10/10 before continuing**
```bash
npm run setup-check
```
Fix anything red, re-run until all green. Never skip this — it's what
catches a bad token, wrong IP-bound CR key, or missing bot invite before a
clan ever sees it.

**⑨ Deploy and start**
```bash
npm run deploy
pm2 start src/index.js --name "<their-clan-name>"
pm2 save
```
No need to re-run `pm2 startup` — that's a one-time thing already set up
for the whole server (makes PM2 itself restart on a server reboot).

**⑩ Confirm it's healthy**
```bash
pm2 status
pm2 logs "<their-clan-name>" --lines 20
```
Look for **online** in the status table and a clean `KRAKEN ONLINE` in the
logs, with nothing above it. This is the gate that matters most — never
tell a clan to proceed until this checks out.

**⑪ Hand off**
- [ ] Confirm the bot shows online in their Discord
- [ ] Tell them to run **`/recruit-setup`**
- [ ] If this clan already had a roster before KRAKEN: tell their **existing**
      members to use the **Link My Account** panel in `#relink`, not the
      welcome panel — this keeps their current standing instead of resetting
      everyone to probation
- [ ] Tell **new** recruits to use **Agree & Join** in `#welcome`

## Notes

- Each clan is a fully isolated instance — its own bot token, own config,
  own database. One clan's problem can never affect another's.
- **`#waiting-list` and the `waitlist` role are created automatically** by
  `/recruit-setup`, same as everything else — nothing to set up by hand.
  Worth asking the clan one question: **auto-open queue** (anyone who joins
  the server while the clan is full gets added automatically — the
  default) or **leader-gated** (set `waitlistRequiresApproval: true` in
  their config — nobody's added until a leader manually assigns the
  `waitlist` role to someone they've approved).
- One VPS can comfortably host ~8 fully active clans on a 1GB box before
  resizing to 2GB is worth considering — see the sizing discussion in this
  project's history if you need the reasoning again.
- If a clan ever wants to stop, `pm2 delete "<their-clan-name>"` removes
  the process (their folder/data stays on disk unless you also delete it).
