import fs from 'node:fs';
import path from 'node:path';

export function readJson(filePath, fallback, logPrefix = 'JSON-STORE') {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[${logPrefix}] Failed to read ${filePath}, falling back to default:`, e?.message ?? String(e));
    return fallback;
  }
}

export function writeJson(filePath, obj) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}
