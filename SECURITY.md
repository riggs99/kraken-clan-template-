# 🔒 Kraken Security Best Practices

## Overview
Kraken follows security best practices to protect your Discord bot, Clash Royale API credentials, and clan data.

## Environment Variables

### Required Configuration
Create a `.env` file in the project root with:

```env
# Discord Bot Configuration
DISCORD_TOKEN=your_discord_bot_token_here
DISCORD_APP_ID=your_application_id_here
DISCORD_GUILD_ID=your_guild_id_here
LEADER_CHANNEL_ID=your_channel_id_for_reports

# Clash Royale API (RoyaleAPI proxy — required unless your host has a static whitelisted IP)
CR_API_BASE=https://proxy.royaleapi.dev
CR_API_TOKEN=your_cr_api_token_here

# Clan Configuration
CLAN_TAG=ABC2YGV

# Optional Settings
GRACE_DAYS=7
REPEAT_WINDOW_DAYS=14
REPEAT_THRESHOLD=2
ALLOWED_ROLE_IDS=role_id_1,role_id_2
```

### Security Measures

1. **Never Commit `.env` File**
   - The `.env` file contains sensitive credentials
   - Always add `.env` to `.gitignore`
   - Never share or commit this file

2. **Environment Validation**
   - Kraken validates all environment variables at startup
   - Invalid configuration causes the bot to exit immediately
   - Prevents running with insecure or incomplete setup

3. **Token Protection**
   - Discord tokens and API keys are never logged
   - Tokens are never exposed in error messages
   - All API calls use HTTPS only

## Input Validation

### Player Name Validation
- All user-provided player names are validated
- Prevents injection attacks
- Limits length to prevent DoS
- Only allows safe characters

### Integer Options
- Days parameters are validated (1-90 range)
- Prevents negative values or extreme numbers
- Returns clear error messages for invalid input

### Clan Tags
- Always validated against expected format
- Alphanumeric only, 3-14 characters
- Prevents injection through malformed tags

## Rate Limiting

### Built-in Protection
- Automatic cleanup of old rate limit data
- Prevents memory leaks
- Configurable per-command limits

### Cooldown System
- Prevents command spam
- Per-user, per-command tracking
- Clear feedback to users

## Error Handling

### Sanitized Error Messages
- File paths are removed from user-facing errors
- Sensitive information is never exposed
- Stack traces only in console logs
- Error messages are length-limited

### Circuit Breaker
- Protects against API rate limits
- Automatic cooldown after repeated failures
- Graceful degradation with cached data

## API Security

### Clash Royale API
- All requests use HTTPS
- Bearer token authentication
- Proper URL encoding for all parameters
- Caching to minimize API calls

### Discord API
- Proper intent configuration (minimal permissions)
- Interaction-based (no message content access required)
- Ephemeral responses for sensitive data

## Access Control

### Role-Based Permissions
- Main clan server (`/ops`): requires the "kraken" role (configurable via `ALLOWED_ROLE_IDS`) or, in Recruit HQ, the "leaders" role
- Recruit HQ leader-only commands/buttons (`/recruit-setup`, `/recruit-eval-now`, `/recruit-settings`, `/recruit-history`, appeal resolution, break acknowledgement) require the "leaders" role or Administrator
- Leader channel restrictions where applicable

### Guild Scoping
- Recruit commands and interactions hard-stop outside the configured `recruitGuildId` — they never appear in or respond in the main clan server
- OPS commands are scoped to `opsGuildId`, with an additional path allowing leaders to run `/ops` from Recruit HQ's ops channel

### Authorization Checks
- Every command verifies permissions
- Clear error messages for unauthorized users
- Audit logging for all commands

## Data Storage

### History Data
- Daily clan snapshots stored locally in JSON (`data/history.json`, rotated to `data/history.archive-*.json`)
- No personal data beyond game stats

### Recruit Data (SQLite)
- Recruit profiles, tier status, break records, appeals, waitlist entries, and evaluator settings are stored locally in `data/kraken.db` (SQLite, WAL mode)
- Contains Discord IDs and Clash Royale player tags — no other personal data
- No external database required; file lives alongside the bot, not exposed over any network interface

### In-Memory Caching
- TTL-based cache expiration
- No persistent sensitive data
- Automatic cleanup

## Deployment Security

### Production Checklist
- [ ] `.env` file configured with all required variables
- [ ] `.env` added to `.gitignore`
- [ ] Bot token regenerated after any accidental exposure
- [ ] Server/VPS properly secured (firewall, SSH keys)
- [ ] Regular updates of dependencies
- [ ] Monitoring and logging enabled
- [ ] Backup of history data

### Updates
```powershell
# Check for security updates
npm audit

# Fix vulnerabilities
npm audit fix

# Update dependencies
npm update
```

## Monitoring

### Logs to Review
- API failures and circuit breaker triggers
- Failed authorization attempts
- Invalid input attempts
- Error patterns

### Alerts to Set Up
- Bot offline/restart notifications
- API quota warnings
- Repeated error patterns
- Suspicious command usage

## Incident Response

### If Bot Token is Compromised
1. Immediately regenerate token in Discord Developer Portal
2. Update `.env` file with new token
3. Restart bot
4. Review audit logs for unauthorized usage
5. Check for any data modifications

### If API Key is Compromised
1. Revoke old API key from Clash Royale Developer Portal
2. Generate new API key
3. Update `.env` file
4. Restart bot

## Code Quality

### Linting
```powershell
# Run linter
npm run lint

# Auto-fix issues
npm run lint:fix
```

### Best Practices
- ESLint configured with security rules
- No eval() or Function() constructors
- Strict equality checks (===)
- No var declarations (const/let only)
- Input validation on all user inputs

## Compliance

### Data Privacy
- No personal data collection
- Only game statistics from public API
- No message content access
- Guild-specific operation

### Rate Limits
- Respects Discord API rate limits
- Respects Clash Royale API quotas
- Circuit breaker prevents abuse
- Caching minimizes requests

## Support

For security concerns or to report vulnerabilities:
1. Review this document
2. Check console logs for specific errors
3. Verify `.env` configuration
4. Run `npm run lint` to check for code issues

## Updates

Last updated: July 2, 2026
Security measures reviewed and validated, including the Recruit HQ subsystem (SQLite storage, second-guild scoping).
