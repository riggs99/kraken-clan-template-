# Hosting Kraken for multiple clans

This describes the model this template is built for: **one host, many fully
isolated clan instances** — not one shared bot serving multiple clans, and
not each clan hosting their own copy. You run the infrastructure; each clan
just invites a bot and runs a couple of Discord commands.

Each instance is completely independent — its own Discord bot, own Clash
Royale API key, own folder, own database. Nothing is shared between clans
except the physical host and the Node.js runtime installed on it.

## Why this model, not the alternatives

Two other models were considered and deliberately not used:

- **Each clan self-hosts their own copy.** Ruled out because it assumes a
  clan owner has (or can get) real technical infrastructure — a lot of real
  clan leaders are mobile-only and have no path to standing up a server
  themselves. This model puts that burden on you once, not on every clan.
- **One shared bot, one shared database, multiple clans invite it in.**
  Ruled out because it requires an actual multi-tenant rebuild (tenant IDs on
  every DB row, per-tenant config resolution, one clan's problem able to
  affect every other clan) — see `docs/kraken2-migration-plan.md` for what
  that would actually take. Not worth it until there's real demand for it.

This model gets the "clan owner doesn't need any infrastructure" benefit of
the first option without the rebuild cost of the second — at the price of
you being the one responsible for keeping every clan's instance running.

## Part A — Set up the host (once)

Any of the options below work; Oracle Cloud's Always Free tier is the
starting recommendation — genuinely free indefinitely, and its RAM (12GB on
the current always-free ARM allocation) comfortably fits many clans' worth of
instances (each instance's own Node process uses roughly 20-30MB at rest).

1. Create the server, connect via SSH.
2. Install Node.js and `pm2` once — shared across every clan you host:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   npm install -g pm2
   ```
3. Make one folder to hold every clan's separate instance:
   ```bash
   mkdir -p ~/krakens
   ```

That's the whole one-time part. Everything else below repeats per clan.

## Part B — Add a clan (repeat for each new one)

Pick a short, consistent name for each clan (e.g. `clan-a`, `clan-b`) — used
consistently below.

**1. Get them their own Discord bot**
Discord Developer Portal → New Application → name it for their clan → Bot
tab → copy the token. Generate an invite URL with `bot` +
`applications.commands` scopes and the permissions this bot needs (Manage
Roles, Manage Channels, Send Messages, Embed Links, Read Message History,
Manage Messages), then use it to invite the bot into *their* server.

**2. Get them their own Clash Royale API key**
Same developer account you already have — generate a **new, separate key**
per clan, bound to this host's IP. Keys are issued individually, so multiple
clans sharing this one host's IP don't share a rate-limit budget as long as
each has its own key. Note their clan tag while you're there.

**3. Give this clan its own isolated folder and code copy**
```bash
cd ~/krakens
git clone <this repo's URL> clan-name
cd clan-name
npm install
```

**4. Configure this clan's settings**
```bash
cp .env.example .env
nano .env
```
Fill in: this clan's Discord bot token, this clan's CR API key, their clan
tag, their Discord server ID.
```bash
nano config/recruit.config.json
```
Fill in their server ID, their clan name (`clanName`), and their invite URL
— replace every `PUT_*` placeholder; the bot refuses to start until they're
all gone. Also update `config/ops.config.json`'s `opsGuildId`.

**5. Register their commands**
```bash
node scripts/deploy-commands.js
```

**6. Start their instance under its own pm2 process name**
```bash
pm2 start src/index.js --name kraken-clan-name \
  --exp-backoff-restart-delay=100 --max-restarts=10 --min-uptime=30000
pm2 save
```
The `--name` is what keeps this clan's process distinct from every other
one — `pm2 status` lists every clan's bot separately, `pm2 logs
kraken-clan-name` shows just theirs, `pm2 restart kraken-clan-name` only
touches theirs. The backoff flags mirror kraken1's Windows self-healing
wrapper's protection against a permanently broken deploy retrying every few
seconds forever (which risks tripping Discord's own per-token login-attempt
limit).

**7. In their Discord — same as always**
- They run `/recruit-setup` once — creates every channel/role this bot needs
  with correct permissions, fully automatically.
- Existing members each click **Link My Account** on the panel in `#relink`
  and submit their player tag — keeps their current standing, no kicks, no
  rejoining. New recruits use the **Agree & Join** panel in `#welcome`
  instead, which always starts them on probation.

That's the entire per-clan process, from your side. The clan owner's entire
involvement is: give you their clan tag, invite the bot, run `/recruit-setup`
— all mobile-friendly, no technical steps on their end at all.

## Managing multiple clans day-to-day

```bash
pm2 status                   # every clan's bot at a glance, all independent
pm2 logs kraken-clan-name    # just that one clan's logs
pm2 restart kraken-clan-name # only touches that one clan
```

`pm2 startup` (run once, after the Node install in Part A) persists all of
this across host reboots — every clan you've added comes back automatically
without redoing anything per clan.

## Things worth knowing before you scale this up

- **If this host's IP ever changes, every clan's CR API key breaks at once**
  — a real reason to prefer a host with a guaranteed-static IP (a cloud VM)
  over something like a home connection for this specific "hosting for
  others" use case.
- **One host going down takes every clan you host offline at the same
  time** — the real tradeoff of this model versus each clan self-hosting.
  Worth deciding deliberately how many clans you're comfortable having that
  blast radius for.
- **Back up every clan's data, not just your own** — the same
  production-data-safety discipline from kraken1's CLAUDE.md (backup before
  any mutation, WAL-safe DB snapshots, never a raw file copy while the bot
  may be writing) applies per clan, independently.
- **You are the support line for every clan added this way.** This model
  removes the infrastructure burden from clan owners; it doesn't remove the
  "something broke, please fix it" burden from you.
