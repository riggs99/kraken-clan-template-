import fs from 'node:fs';
import path from 'node:path';
import { getRecruitSetting, setRecruitSetting } from './recruit/db.js';

const ICON_PATH = path.join(process.cwd(), 'assets', 'kraken-icon.png');

// Bump this if the icon image is ever replaced — it's the only thing that makes
// ensureBotIcon try again. Discord's own avatar/profile-edit endpoint is rate-limited,
// so this is checked BEFORE calling setAvatar, not just to save a call: re-uploading
// an identical image on every single bot restart would burn through that budget for
// zero visible change.
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
