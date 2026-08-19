'use strict';
// Safe JSON read/write. Every write is backed up first and lands atomically,
// because these files are a developer's live agent config.
const fs = require('fs');
const path = require('path');
const { BACKUP_DIR } = require('./paths');

// Windows drive letters differ in case between sources ("C:/" vs "c:/"), and
// ~/.claude.json legitimately contains keys that collide once case is folded.
// JSON.parse keeps the last one, which is what Claude Code itself does.
function readJson(file, fallback = null) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  if (!raw.trim()) return fallback;
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (e) {
    const err = new Error(`malformed JSON in ${file}: ${e.message}`);
    err.code = 'EBADJSON';
    err.file = file;
    throw err;
  }
}

// Never throws. Use where a bad file should degrade rather than break the panel.
function readJsonSoft(file, fallback = null) {
  try {
    return readJson(file, fallback);
  } catch {
    return fallback;
  }
}

function backup(file, stamp) {
  if (!fs.existsSync(file)) return null;
  const dir = path.join(BACKUP_DIR, stamp);
  fs.mkdirSync(dir, { recursive: true });
  // Flatten the path so two files with the same basename cannot collide.
  const safe = file.replace(/[\/:]+/g, '_').replace(/^_+/, '');
  const dest = path.join(dir, safe);
  fs.copyFileSync(file, dest);
  return dest;
}

// Write via temp + rename so a crash mid-write cannot leave a truncated
// settings.json behind. Falls back to a direct write if rename is refused
// (some Windows AV and sync clients lock the target briefly).
function writeJson(file, obj, stamp) {
  backup(file, stamp || 'unstamped');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify(obj, null, 2) + '\n';
  const tmp = `${file}.patchbay-${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    if (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY') {
      fs.writeFileSync(file, body);
    } else {
      throw e;
    }
  }
  return file;
}

module.exports = { readJson, readJsonSoft, backup, writeJson };
