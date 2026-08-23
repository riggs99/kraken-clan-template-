import fs from 'node:fs';
import path from 'node:path';
import { getRecruitSetting, setRecruitSetting } from './recruit/db.js';

const ICON_PATH = path.join(process.cwd(), 'assets', 'kraken-icon.png');

// Bump this if the icon image is ever replaced — it's the only thing that makes
// ensureBotIcon try again. Checked BEFORE calling setAvatar so a restart never
// re-uploads an identical image for zero visible change. Confirmed against discord.js's
// own source (ClientUser.js) that setAvatar/setUsername share the same PATCH /users/@me
// endpoint, and setUsername is explicitly documented there as limited to 2 requests/hour
// — avatar isn't separately documented, but sharing the endpoint is reason enough to
// treat it the same way rather than assume it's exempt.
const ICON_VERSION = '1';

// Sets this clan's bot avatar to the shared KRAKEN brand icon, once. Every clan's bot
// is a separate Discord application (see CLAUDE.md's per-clan isolation model), so
// there is no way to set this once "for all clans" at the Discord API level — this is
// what makes every new clan's bot get it automatically instead of a manual upload step
// in the Developer Portal each time.
export async function ensureBotIcon(client, db) {
  if (!fs.existsSync(ICON_PATH)) return; // template ships without a real image by default

  const appliedVersion = String(getRecruitSetting(db, 'brand.iconVersion') ?? '');
  if (appliedVersion === ICON_VERSION) return;

  try {
    await client.user.setAvatar(ICON_PATH);
    setRecruitSetting(db, 'brand.iconVersion', ICON_VERSION);
    console.log('[BRAND] Bot avatar set from assets/kraken-icon.png');
  } catch (e) {
    console.error('[BRAND] Failed to set bot avatar:', e?.message ?? String(e));
  }
}
