# 🐙 Kraken Features

## Automated Reports

### 📅 Daily Reports (20:00 UTC)
Automatic daily clan activity summary sent to your configured leader channel:
- Today's active member count
- Total fame, repairs, boat attacks, decks used
- 7-day participation average
- Top 5 performers of the day
- Members needing attention (high risk score)

**Configuration:** Set `LEADER_CHANNEL_ID` in `.env`

### 📊 Weekly Reports (Sunday 20:00 UTC)
Comprehensive weekly analysis with actionable recommendations:
- Promotion candidates (→ Elder, → Co-Leader)
- Demotion candidates (Co → Elder, Elder → Member)
- Kick candidates with risk scores
- Summary counts and next steps

**Analysis Window:** 14 days of historical data

## Slash Commands

The command list previously here (`/ping`, `/clan`, `/player`, `/war`, `/warlog`, `/activity`, `/recent`, `/review`, `/promotions`, `/leaderboard`, `/donations`) has been replaced. All of that functionality (clan overview, player lookup, war stats, donations, promotion/demotion/kick recommendations with receipts) now lives inside the single **`/ops`** command's tabbed panel (Overview / War / Donations / Actions), and the scoring logic described below (risk weighting, grace period, promotion/demotion/kick thresholds) still applies unchanged.

There is also a full **Recruit HQ** subsystem (application intake, automated tier tracking, breaks, appeals, waitlist) running in a second Discord server — see [docs/commands.md](docs/commands.md) for the complete current reference.

## Player Name Resolution

### Smart Name Matching
- **Case-insensitive** - "john" matches "JOHN", "John", etc.
- **Clash formatting removal** - Strips `<c6>`, `</c>` color tags
- **Whitespace normalization** - Handles extra spaces, dashes, underscores
- **Multi-source search** - Checks current roster + 7-day history

### Disambiguation
When multiple players match:
- Shows "did you mean" list
- Includes role, last seen, and source
- Clear formatting with emojis

**Examples:**
```
/player name:shadow
/activity name:john doe  
/review name:ProGamer
```

## Risk Scoring System

### Weighted Risk Analysis
- **War Participation (60%)** - Most important factor
- **Deck Usage (25%)** - Missing decks is bad
- **Donations (10%)** - Contribution to clan
- **Inactivity (5%)** - Days since last seen
- **Recent Zeros Penalty** - 2 consecutive zero-fame days

### Grace Period
- **7 days** from first seen (configurable)
- In grace: can be promoted, never demoted/kicked
- Gives new members time to prove themselves

### Repeat Offender Detection
- Tracks bottom list appearances over 14 days
- Threshold of 2 appearances
- Only counts when NOT in grace period

## Promotion Classification

### Promote → Elder
- Current role: Member
- War participation ≥ 90%
- Deck miss rate ≤ 10%
- Risk score ≤ 15%
- NOT in grace or repeat offender

### Promote → Co-Leader
- Current role: Elder
- War participation ≥ 95%
- Deck miss rate ≤ 5%
- Risk score ≤ 10%
- NOT in grace or repeat offender

### Demote Co → Elder
- Current role: Co-Leader
- Risk ≥ 55% OR participation < 60% OR repeat offender

### Demote Elder → Member
- Current role: Elder
- Risk ≥ 65% OR participation < 50% OR repeat offender

### Kick Candidates
- Current role: Member
- NOT in grace
- Risk ≥ 85% OR inactive ≥ 14 days OR (repeat offender AND risk ≥ 75%)

## Comprehensive Stats Display

Every player shown includes:
```
war:94% • deckMiss:6% • fame:+1200 • decksUsed:38 • repairs:+120 • boatAtk:3 • donAvg:18 • inactive:1d • risk:9%
```

### Stats Include
- War participation rate (%)
- Deck miss rate (%)
- Total fame in window
- Total decks used in window
- Total repair points in window
- **Boat attacks** (negative signal - discipline issue)
- Average donations per day
- Days inactive
- Risk percentage

## Receipts (Reasons)

### Promotion Reasons (3-6)
- Consistent war participation
- Strong deck discipline
- Fame contribution over window
- Recently active
- Good support via repairs
- Clean history, no flags

### Demotion/Kick Reasons (3-6)
- War no-shows
- Missed decks
- Low or zero war contribution
- Inactivity trend
- Repeat offender
- High risk score
- **Boat attacks detected** (discipline issue)

## Security Features

### Input Validation
- Player names validated (length, characters)
- Integer options validated (range checks)
- Clan tags validated (format, length)
- Channel IDs validated (Discord format)

### Rate Limiting
- Per-user, per-command tracking
- Automatic cleanup of old data
- Prevents abuse and spam

### Error Sanitization
- File paths removed from errors
- Sensitive info never exposed
- Length-limited messages
- Stack traces only in console

### Environment Validation
- All required variables checked at startup
- Format validation (URLs, IDs, tags)
- Bot exits if misconfigured
- Clear error messages for admins

## Caching & Circuit Breaker

### Intelligent Caching
- Clan data: 60 seconds
- Player data: 120 seconds
- Current race: 120 seconds
- Race log: 600 seconds

### Circuit Breaker
- Protects against API rate limits
- Automatic cooldown after failures
- Graceful degradation with cache
- User-friendly error messages

## Historical Tracking

### Data Persistence
- Daily snapshots in `data/history.json`
- First seen tracking for grace period
- Bottom list tracking for repeat offenders
- 7-14 day analysis windows

### Trend Analysis
- Compare today vs. baseline
- Identify improving/declining players
- Track consistency over time
- Support data-driven decisions

## Access Control

### Role-Based Permissions
- Requires "kraken" role (configurable via `ALLOWED_ROLE_IDS`)
- Guild-specific operation
- Leader channel restrictions
- Clear error messages for unauthorized users

### Audit Logging
- All commands logged to console
- User, command, and timestamp
- Error tracking and debugging

## Code Quality

### ESLint Configuration
- Security-focused rules
- No eval() or Function() constructors
- Strict equality checks
- Modern JavaScript (ES2022)

### Development Scripts
```powershell
npm start          # Run the bot
npm run deploy     # Deploy slash commands
npm run lint       # Check code quality
npm run lint:fix   # Auto-fix issues
```

## Performance

### Minimal Discord Permissions
- No message content access required
- Interaction-based only
- Guild-specific intents
- Ephemeral responses for sensitive data

### Efficient API Usage
- TTL-based caching
- Circuit breaker prevents over-calling
- Parallel requests where possible
- Respects rate limits

## Customization

### Environment Variables
```env
GRACE_DAYS=7                    # Grace period for new members
REPEAT_WINDOW_DAYS=14          # Repeat offender tracking window
REPEAT_THRESHOLD=2             # Number of appearances to flag
ALLOWED_ROLE_IDS=role1,role2   # Comma-separated role IDs
LEADER_CHANNEL_ID=channel_id   # Channel for reports
```

### Flexible Analysis Windows
- Default: 7 days for daily analysis
- Default: 14 days for weekly reports
- Custom: 1-90 days via `/promotions days:<days>`

## Best Practices

### Decision Support
Kraken provides **recommendations only**:
- NEVER kicks automatically
- NEVER promotes automatically
- NEVER demotes automatically
- You review and take manual action

### Data-Driven Decisions
- Comprehensive stats for every player
- 3-6 specific reasons for each recommendation
- Historical context and trends
- Multiple data signals combined

### Transparency
- All logic is explainable
- Reasons shown to users
- Risk scores visible
- History tracking for accountability

## Future-Proof Design

### Modular Architecture
- Separate modules for each concern
- Easy to extend with new commands
- Clean separation of business logic
- Reusable utilities

### Error Resilience
- Try-catch on all async operations
- Graceful degradation
- User-friendly error messages
- Never crashes the bot

### Maintainability
- Well-documented code
- Security best practices
- Input validation everywhere
- Consistent code style

---

For setup instructions, see [README.md](README.md)  
For security details, see [SECURITY.md](SECURITY.md)  
For the current command reference, see [docs/commands.md](docs/commands.md)
