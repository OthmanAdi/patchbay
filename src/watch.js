'use strict';
// Live config watching.
//
// Three Windows realities drive this design:
//   1. fs.watch fires several events for one save. Everything is debounced.
//   2. An event can arrive before the write is finished, so a read straight
//      after it can see a truncated or empty file. The debounce window doubles
//      as a settle window.
//   3. Editors and patchbay itself replace files atomically (temp + rename).
//      A watcher bound to the file handle silently detaches when that happens,
//      so we watch the DIRECTORY and filter by filename instead. That also
//      means a file which does not exist yet is covered the moment it appears.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DEBOUNCE_MS = 200;      // coalesce a burst of events into one settle
const SELF_WRITE_MS = 1200;   // ignore echoes of our own writes for this long

class ConfigWatcher extends EventEmitter {
  constructor() {
    super();
    this.dirs = new Map();      // dir -> { watcher, files:Set<string> }
    this.timer = null;
    this.selfWriteUntil = 0;
    this.pendingReason = new Set();
  }

  // Rebuild the watch set from a flat list of file paths. Idempotent: existing
  // directory watchers are kept, ones no longer needed are closed, so calling
  // this on every folder add/remove cannot leak handles.
  setPaths(files) {
    const wanted = new Map();
    for (const f of files) {
      if (!f) continue;
      const dir = path.dirname(path.resolve(f));
      const base = path.basename(f);
      if (!wanted.has(dir)) wanted.set(dir, new Set());
      wanted.get(dir).add(base);
    }

    for (const [dir, entry] of this.dirs) {
      if (!wanted.has(dir)) {
        try { entry.watcher.close(); } catch {}
        this.dirs.delete(dir);
      }
    }

    for (const [dir, names] of wanted) {
      const existing = this.dirs.get(dir);
      if (existing) { existing.files = names; continue; }
      if (!fs.existsSync(dir)) continue; // nothing to watch yet
      let watcher;
      try {
        watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
          if (!filename) { this._bump(dir); return; }
          const set = this.dirs.get(dir);
          if (set && set.files.has(path.basename(filename))) {
            this._bump(path.join(dir, filename));
          }
        });
      } catch {
        continue; // unreadable directory, skip rather than crash the panel
      }
      watcher.on('error', () => {
        try { watcher.close(); } catch {}
        this.dirs.delete(dir);
      });
      this.dirs.set(dir, { watcher, files: names });
    }
    return this.dirs.size;
  }

  // Call immediately before writing config, so the resulting watch events do
  // not bounce back as a "someone changed your config" push and stomp on the
  // user's in-flight edits.
  markSelfWrite(ms = SELF_WRITE_MS) {
    this.selfWriteUntil = Date.now() + ms;
  }

  _bump(reason) {
    this.pendingReason.add(reason);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const reasons = [...this.pendingReason];
      this.pendingReason.clear();
      if (Date.now() < this.selfWriteUntil) {
        this.emit('self', reasons);
        return;
      }
      this.emit('change', reasons);
    }, DEBOUNCE_MS);
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    for (const [, e] of this.dirs) { try { e.watcher.close(); } catch {} }
    this.dirs.clear();
  }
}

// Cheap stable fingerprint. Pushing an identical state to the browser is worse
// than useless: it fights whatever the user is currently typing.
function hashState(obj) {
  const json = JSON.stringify(obj, stableKeys);
  let h = 5381;
  for (let i = 0; i < json.length; i++) h = ((h * 33) ^ json.charCodeAt(i)) >>> 0;
  return h.toString(36) + '-' + json.length.toString(36);
}

function stableKeys(_key, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value).sort().reduce((a, k) => { a[k] = value[k]; return a; }, {});
  }
  return value;
}

module.exports = { ConfigWatcher, hashState, DEBOUNCE_MS, SELF_WRITE_MS };
