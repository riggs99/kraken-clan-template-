# KRAKEN — Operations

**First-time setup lives in [SETUP.md](SETUP.md)** — creating the bot, inviting
it, the CR API key, config, `/recruit-setup`, and members joining. This file
covers keeping an instance running once it's set up.

For running instances for **many** clans off one host (pm2, cloud VM, per-clan
process names), see [docs/multi-clan-hosting.md](docs/multi-clan-hosting.md).

---

## Running in production

For anything beyond a quick local test, run the bot under a process manager so
it restarts on crash and survives reboots. `pm2` is the recommended one, with
backoff limits so a permanently broken deploy can't hammer Discord's login
endpoint:

```bash
pm2 start src/index.js --name kraken-<clan> \
  --exp-backoff-restart-delay=100 --max-restarts=10 --min-uptime=30000
pm2 save
pm2 startup     # once per host, to persist across reboots
```

`docs/multi-clan-hosting.md` has the full per-clan procedure. A healthy process
logs `KRAKEN ONLINE` on start and a `[SCHEDULE] Kraken heartbeat OK` line
periodically.

---

## Updating the bot

```bash
git pull
npm install            # in case dependencies changed
npm run deploy         # only if the command set changed
pm2 restart kraken-<clan>
```

---

## Backups

The only irreplaceable state is in `data/`:

- `data/history.json` — clan performance history
- `data/kraken.db` — profiles, standings, tracking state

Back these up before any manual mutation. The database is **WAL-mode SQLite** —
never copy `kraken.db` with a raw file copy while the bot may be writing (you'll
miss recent writes sitting in the `-wal` file). Use a WAL-safe snapshot (the
bot's own `.backup()` path checkpoints first), or stop the bot before copying.

```bash
# Example: snapshot history alongside a timestamp
cp data/history.json "backups/history-$(date +%F).json"
```

---

## Configuration reference

- Every environment variable the bot reads is documented inline in
  `.env.example` (required ones and their defaults).
- `config/recruit.config.json` / `config/ops.config.json` only need their guild
  IDs, clan name, and invite URL — `/recruit-setup` discovers and stores every
  channel/role ID in SQLite itself.
- `ALLOWED_ROLE_IDS` (optional, comma-separated role IDs) is an extra
  authorization gate read by `src/permissions.js`; leave it unset unless you
  specifically need it — recruit permissions run off the `leaders` role that
  `/recruit-setup` creates.

---

## Troubleshooting

`npm run setup-check` is the first thing to run for almost any problem — it
checks the live state (token, server membership, permissions, CR API, database,
commands) and prints a specific fix for each failure. The
[SETUP.md troubleshooting section](SETUP.md#troubleshooting) covers the common
cases (CR API 403 → proxy IP, role grant failures → hierarchy, placeholders,
missing env vars, commands not appearing).

---

## Security

- Never commit `.env` — it's gitignored; keep it that way.
- If a bot token is ever exposed, reset it in the Discord Developer Portal
  immediately and update `.env`.
- Keep real config IDs and any `data/` contents out of commits — this repo is a
  reusable template; committed state should stay generic (`PUT_*` placeholders
  in config, nothing in `data/`).
- Back up `data/` before any irreversible operation, and dry-run/preview
  destructive actions before confirming.
