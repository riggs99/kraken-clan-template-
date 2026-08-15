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
server ID. `CR_API_TOKEN` → reuse your own key (it reads any clan's public
data — no need for a new one per clan). `CLAN_TAG` → theirs. Save: Ctrl+O,
Enter, Ctrl+X.

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
- [ ] Tell them to get members running **`/apply`**

## Notes

- Each clan is a fully isolated instance — its own bot token, own config,
  own database. One clan's problem can never affect another's.
- One VPS can comfortably host ~8 fully active clans on a 1GB box before
  resizing to 2GB is worth considering — see the sizing discussion in this
  project's history if you need the reasoning again.
- If a clan ever wants to stop, `pm2 delete "<their-clan-name>"` removes
  the process (their folder/data stays on disk unless you also delete it).
