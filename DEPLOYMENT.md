# 🚀 Kraken Deployment Guide

## Prerequisites

- Windows with PowerShell
- Node.js v20 or higher
- Discord Bot created in Discord Developer Portal
- Clash Royale API token
- Git (optional, for version control)

## Initial Setup

### 1. Install Dependencies

```powershell
cd C:/path/to/kraken-clan-template
npm install
```

This installs:
- `discord.js` - Discord API library
- `dotenv` - Environment variable management
- `node-fetch` - HTTP client for Clash Royale API
- `eslint` - Code quality checker (dev dependency)

### 2. Configure Environment

Create `.env` file in project root:

```powershell
Copy-Item .env.example .env
notepad .env
```

Fill in all required values:

```env
# Discord Configuration
  DISCORD_TOKEN=your_bot_token_from_discord_developer_portal
  DISCORD_APP_ID=your_application_id_from_discord_developer_portal
  DISCORD_GUILD_ID=your_server_id_right_click_server_copy_id
  # Where automated daily/weekly reports are posted.
  # Use REPORTS_CHANNEL_ID if you want to keep LEADER_CHANNEL_ID reserved for OPS "channel lock" auth.
  REPORTS_CHANNEL_ID=your_channel_id_for_automated_reports
  LEADER_CHANNEL_ID=optional_channel_lock_for_ops

# Clash Royale API (use the RoyaleAPI proxy unless you have a static whitelisted IP)
CR_API_BASE=https://proxy.royaleapi.dev
CR_API_TOKEN=your_api_token_from_clash_royale_developer_site

# Clan Configuration
CLAN_TAG=ABC2YGV

# Optional (defaults shown)
GRACE_DAYS=7
REPEAT_WINDOW_DAYS=14
REPEAT_THRESHOLD=2
ALLOWED_ROLE_IDS=role_id_1,role_id_2  # comma-separated, no spaces
```

### 3. Deploy Slash Commands

```powershell
npm run deploy
```

Expected output:
```
Deploying slash commands...
✅ Commands deployed
```

If you see `403 Missing Access`, re-invite your bot with the `applications.commands` scope.

### 4. Verify Configuration

The bot validates your `.env` at startup. Run a quick check:

```powershell
npm start
```

Expected output:
```
🐙 KRAKEN ONLINE as YourBot#1234
[SCHEDULE] Daily and weekly reports configured
[SCHEDULE] Kraken heartbeat OK
```

If you see errors, check your `.env` file against the requirements.

## Discord Bot Setup

### Create Bot in Discord Developer Portal

1. Go to https://discord.com/developers/applications
2. Click "New Application"
3. Name it "Kraken" (or your preferred name)
4. Go to "Bot" section
5. Click "Add Bot"
6. **Copy the token** → Save to `DISCORD_TOKEN` in `.env`
7. Under "Privileged Gateway Intents", enable:
   - Server Members Intent (optional, for member counts)
8. Under "General Information", copy Application ID → Save to `DISCORD_APP_ID`

### Invite Bot to Server

Generate invite URL with:
- **Scopes:** `bot`, `applications.commands`
- **Permissions:** 
  - Send Messages
  - Embed Links
  - Read Message History
  - Use Slash Commands

Invite URL format:
```
https://discord.com/api/oauth2/authorize?client_id=YOUR_APP_ID&permissions=19456&scope=bot%20applications.commands
```

### Set Up Role and Channel

1. Create a role called "kraken" in your server
2. Assign this role to users who should access Kraken commands
3. Copy the role ID (Developer Mode → Right-click role → Copy ID)
4. Add to `.env` as `ALLOWED_ROLE_IDS`

5. Create or identify your leader channel
6. Copy the channel ID → Add to `.env` as `LEADER_CHANNEL_ID`

7. Copy your server ID → Add to `.env` as `DISCORD_GUILD_ID`

## Clash Royale API Setup

### Get API Token

1. Go to https://developer.clashroyale.com
2. Log in with your Supercell ID
3. Go to "My Account"
4. Create a new API key
5. Enter your public IP address (not localhost)
6. Copy the token → Save to `CR_API_TOKEN` in `.env`

**Note:** If your IP changes, you'll need to regenerate the key.

## Running the Bot

### Development (Console)

```powershell
npm start
```

Press `Ctrl+C` to stop.

### Production (Windows Task Scheduler)

For 24/7 operation, the bot runs via **Windows Task Scheduler** (task name `KrakenBot`), not PM2. PM2 was tried first but its named-pipe IPC returns `EPERM` on Windows and cannot be fixed — Task Scheduler is the current, working setup and uses fewer resources (no daemon process).

```powershell
# Start the bot now (without rebooting)
Start-ScheduledTask -TaskName KrakenBot

# Stop the bot (and prevent auto-restart)
& C:/path/to/kraken-clan-template\scripts\kraken-stop.ps1

# Re-enable auto-start after stopping
Enable-ScheduledTask -TaskName KrakenBot

# Watch live logs
Get-Content "C:/path/to/kraken-clan-template\logs\kraken-$(Get-Date -Format 'yyyy-MM-dd').log" -Wait
```

Full reference, including how to re-register the task from scratch: [docs/bot-startup.md](docs/bot-startup.md).

## Verification

### Test Commands in Discord

1. `/ops` - Should open the main command panel (Overview / War / Donations / Actions tabs)
2. In Recruit HQ (if enabled): `/status`, `/apply` - see [docs/commands.md](docs/commands.md) for the full recruit command/feature reference

### Check Automated Reports

Daily reports send at 20:00 UTC daily
Weekly reports send on Sunday at 20:00 UTC

To test immediately, temporarily modify the time checks in `src/schedule.js`.

## Maintenance

### Update Bot Code

```powershell
# Pull latest changes (if using Git)
git pull

# Install any new dependencies
npm install

# Redeploy commands if changed
npm run deploy

# Restart bot
& C:/path/to/kraken-clan-template\scripts\kraken-stop.ps1
Start-ScheduledTask -TaskName KrakenBot
```

### Update Dependencies

```powershell
# Check for updates
npm outdated

# Update all
npm update

# Check for security vulnerabilities
npm audit

# Fix vulnerabilities
npm audit fix
```

### Code Quality Check

```powershell
# Run linter
npm run lint

# Auto-fix issues
npm run lint:fix
```

## Backup

### What to Back Up

1. `.env` file (store securely, never commit to Git)
2. `data/history.json` (clan performance history)
3. Any custom configuration files

```powershell
# Create backup
$date = Get-Date -Format "yyyy-MM-dd"
Copy-Item data/history.json "backups/history-$date.json"
```

### Restore from Backup

```powershell
# Restore history
Copy-Item "backups/history-2026-01-17.json" data/history.json
```

## Troubleshooting

### PM2 is no longer used

PM2 was the original process manager but was abandoned — `pm2` commands fail on this machine with `Error: connect EPERM //./pipe/rpc.sock`, a Windows OS-level restriction on PM2's named-pipe IPC that wiping `~/.pm2` does not fix. The bot now runs via **Windows Task Scheduler** instead (see the "Production" section above and [docs/bot-startup.md](docs/bot-startup.md)). If you see `rpc.sock` errors, you're running a stale PM2 command — use the Task Scheduler commands instead.

### Recruit: auto-removal safety switch

The post-break enforcement can DM warnings and (optionally) remove/purge users after an expired break + inactivity.
Auto-removal is **disabled unless both** of these are set:

```env
RECRUIT_ENABLE_AUTO_REMOVE=1
RECRUIT_ENABLE_AUTO_REMOVE_CONFIRM=YES
```

### Bot Won't Start

**Error: Missing environment variable**
- Check `.env` file exists
- Verify all required variables are set
- Ensure no typos in variable names

**Error: Invalid token**
- Regenerate token in Discord Developer Portal
- Update `.env` file
- Restart bot

### Commands Not Working

**"Unknown command" error**
- Run `npm run deploy` to register commands
- Wait a few minutes for Discord to propagate
- If using guild commands, ensure `DISCORD_GUILD_ID` is correct

**"Missing Access" error**
- Re-invite bot with `applications.commands` scope
- Check bot permissions in server settings

### API Issues

**"Circuit breaker open" error**
- API is in cooldown due to rate limiting
- Wait for cooldown to expire (check `/status`)
- If persistent, check API token is valid

**"API misconfigured" error**
- Verify `CR_API_BASE` is `https://api.clashroyale.com`
- Verify `CR_API_TOKEN` is valid
- Check your IP hasn't changed

### Permission Errors

**"You do not have the kraken role" error**
- Assign the role to your user
- Verify `ALLOWED_ROLE_IDS` in `.env`
- Check role ID is correct (right-click role → Copy ID)

### Report Not Sending

**Daily/Weekly reports not appearing**
- Check `LEADER_CHANNEL_ID` is correct
- Verify bot has permission to send messages in that channel
- Check bot console logs for errors
- Verify time zone (reports use UTC)

## Security Reminders

- ✅ Never commit `.env` to Git
- ✅ Regenerate tokens if accidentally exposed
- ✅ Use strong passwords for server access
- ✅ Keep Node.js and dependencies updated
- ✅ Review console logs regularly
- ✅ Back up history data regularly

## Getting Help

1. Check console logs for error messages
2. Review [SECURITY.md](SECURITY.md) for security issues
3. Review [docs/commands.md](docs/commands.md) for the current command/feature reference
4. Review [docs/bot-startup.md](docs/bot-startup.md) for process management (start/stop/logs)
5. Run `npm run lint` to check for code issues

## Production Checklist

- [ ] `.env` configured with all required variables
- [ ] `.env` added to `.gitignore` (already included)
- [ ] Dependencies installed (`npm install`)
- [ ] Commands deployed (`npm run deploy`)
- [ ] Bot invited to server with correct permissions
- [ ] Kraken role created and assigned
- [ ] Leader channel configured
- [ ] Test commands working in Discord
- [ ] Windows Task Scheduler task (`KrakenBot`) registered for 24/7 operation (see docs/bot-startup.md)
- [ ] Backup strategy in place
- [ ] Monitoring and logging reviewed
- [ ] API token has correct IP address

## Post-Deployment

Once deployed:
- Commands are available immediately
- History tracking begins on first command use
- Daily reports start next 20:00 UTC
- Weekly reports start next Sunday 20:00 UTC
- Data accumulates in `data/history.json`

Enjoy! 🐙
