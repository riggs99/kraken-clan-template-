import fs from 'node:fs';
import path from 'node:path';

const METADATA_PATH = path.join(process.cwd(), 'data', 'metadata.json');

const DEFAULT_METADATA = {
  warnings: {},
  notes: {},
  milestones: [],
};

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[METADATA] Failed to read ${filePath}, falling back to default:`, e?.message ?? String(e));
    return fallback;
  }
}

function writeJson(filePath, obj) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Load metadata (warnings, notes, milestones, etc.)
 */
export function loadMetadata() {
  return readJson(METADATA_PATH, { ...DEFAULT_METADATA, warnings: {}, notes: {}, milestones: [] });
}

/**
 * Save metadata
 */
export function saveMetadata(metadata) {
  writeJson(METADATA_PATH, metadata);
}

/**
 * Add a warning to a player
 */
export function addWarning(playerTag, reason, issuedBy) {
  const meta = loadMetadata();
  if (!meta.warnings[playerTag]) {
    meta.warnings[playerTag] = [];
  }
  meta.warnings[playerTag].push({
    date: new Date().toISOString(),
    reason,
    issuedBy
  });
  saveMetadata(meta);
  return meta.warnings[playerTag].length;
}

/**
 * Get warnings for a player
 */
export function getWarnings(playerTag) {
  const meta = loadMetadata();
  return meta.warnings[playerTag] || [];
}

/**
 * Clear warnings for a player
 */
export function clearWarnings(playerTag) {
  const meta = loadMetadata();
  delete meta.warnings[playerTag];
  saveMetadata(meta);
}

/**
 * Add a note to a player
 */
export function addNote(playerTag, note, author) {
  const meta = loadMetadata();
  if (!meta.notes[playerTag]) {
    meta.notes[playerTag] = [];
  }
  meta.notes[playerTag].push({
    date: new Date().toISOString(),
    note,
    author
  });
  saveMetadata(meta);
}

/**
 * Get notes for a player
 */
export function getNotes(playerTag) {
  const meta = loadMetadata();
  return meta.notes[playerTag] || [];
}

/**
 * Add milestone
 */
export function addMilestone(type, description) {
  const meta = loadMetadata();
  meta.milestones.push({
    date: new Date().toISOString(),
    type,
    description
  });
  saveMetadata(meta);
}

/**
 * Get recent milestones
 */
export function getMilestones(limit = 10) {
  const meta = loadMetadata();
  return (meta.milestones || []).slice(-limit).reverse();
}
