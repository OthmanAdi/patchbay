'use strict';
// Turn a set of pending toggles into a plan, then execute the plan.
//
// The old code read the settings file, mutated it, and then called a headroom
// branch that ALSO read and wrote the same file inside the same loop. The
// second write was built from a stale read, so the first change was silently
// lost. Everything here is staged in memory first and each file is written
// exactly once.
const fs = require('fs');
const path = require('path');
const { readJson, readJsonSoft, writeJson } = require('./jsonio');
const { byId } = require('./registry');
const { userConfig, writeTarget, USER_SETTINGS } = require('./paths');
const { normalizeFolder } = require('./state');

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// A staged edit set: every file is loaded at most once and written at most once.
class Txn {
  constructor() {
    this.docs = new Map();   // file -> object
    this.ops = [];           // human-readable plan
    this.flags = new Map();  // file -> string | null (null = delete)
  }
  // STRICT read on purpose. A soft read that turns an unparseable settings.json
  // into {} would then be written back, replacing a developer's hooks,
  // permissions and mcpServers with the two keys patchbay cares about.
  doc(file) {
    if (!this.docs.has(file)) {
      let obj;
      try {
        obj = readJson(file, {}) || {};
      } catch (e) {
        this.aborted = this.aborted || e.message;
        throw e;
      }
      this.docs.set(file, obj);
    }
    return this.docs.get(file);
  }
  note(level, msg, file) {
    this.ops.push({ level, msg, file: file || null });
  }
  flag(file, value) {
    this.flags.set(file, value);
  }
  commit(watcher) {
    const s = stamp();
    const written = [];
    if (watcher) watcher.markSelfWrite();
    for (const [file, obj] of this.docs) {
      writeJson(file, obj, s);
      written.push(file);
    }
    for (const [file, value] of this.flags) {
      try {
        if (value === null) {
          if (fs.existsSync(file)) { fs.unlinkSync(file); written.push(file); }
        } else {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, value);
          written.push(file);
        }
      } catch (e) {
        this.note('error', `could not write ${path.basename(file)}: ${e.message}`, file);
      }
    }
    return { written, stamp: s };
  }
}

// Stage one scope's worth of changes. `folder` is null for the user scope.
function stageScope(txn, folder, changes, opts = {}) {
  if (folder) {
    const n = normalizeFolder(folder);
    if (!n) {
      txn.note('error', `refused: "${folder}" is not an absolute path to an existing folder`, null);
      return;
    }
    folder = n;
  }
  const target = writeTarget(folder);

  for (const [id, change] of Object.entries(changes || {})) {
    const p = byId(id);
    if (!p) continue;

    if (folder && p.globalOnly) {
      txn.note('warn', `${p.label} is global only, skipped for this folder`, null);
      continue;
    }

    // --- on/off ---
    if (typeof change.enabled === 'boolean') {
      if (p.id === 'headroom') {
        stageHeadroom(txn, change.enabled, opts);
      } else {
        const doc = txn.doc(target);
        doc.enabledPlugins = doc.enabledPlugins || {};
        doc.enabledPlugins[p.plugin] = change.enabled;
        txn.note('ok', `${p.label} ${change.enabled ? 'ON' : 'OFF'}`, target);
      }
      if (p.flagIsPresence && !folder) {
        txn.flag(p.flag, change.enabled ? '1' : null);
        txn.note('ok', `${p.label} always-on flag ${change.enabled ? 'written' : 'removed'}`, p.flag);
      }
    }

    // --- level ---
    if (change.level && p.levels) {
      if (!p.levels.includes(change.level)) {
        txn.note('error', `${p.label}: "${change.level}" is not one of ${p.levels.join('/')}`, null);
      } else if (folder && !p.folderConfigNames) {
        txn.note('warn', `${p.label} level is global only (its loader never reads a repo config)`, null);
      } else {
        const cfg = folder
          ? path.join(folder, p.folderConfigNames[0])
          : userConfig(p.configName);
        const doc = txn.doc(cfg);
        doc.defaultMode = change.level;
        txn.note('ok', `${p.label} level ${change.level}`, cfg);
        // Keep the live flag in step. SessionStart would re-derive it from the
        // config anyway, but leaving it stale makes the statusline lie until then.
        if (!folder && p.flag) {
          txn.flag(p.flag, change.level);
          txn.note('ok', `${p.label} flag synced to ${change.level}`, p.flag);
        }
      }
    }

    // --- env var (ponytail subagent matcher) ---
    if (change.env !== undefined && p.envKey) {
      if (folder) {
        txn.note('warn', `${p.envKey} is global only, skipped for this folder`, null);
      } else {
        const doc = txn.doc(USER_SETTINGS);
        doc.env = doc.env || {};
        if (change.env === null || change.env === '') {
          delete doc.env[p.envKey];
          txn.note('ok', `${p.envKey} cleared, every subagent gets the ruleset`, USER_SETTINGS);
        } else {
          try {
            new RegExp(change.env);
            doc.env[p.envKey] = change.env;
            txn.note('ok', `${p.envKey}=${change.env}`, USER_SETTINGS);
          } catch {
            txn.note('error', `"${change.env}" is not a valid regex, not written`, null);
          }
        }
      }
    }
  }
}

function stageHeadroom(txn, on, opts) {
  const p = byId('headroom');
  const doc = txn.doc(USER_SETTINGS);
  doc.env = doc.env || {};
  doc.enabledPlugins = doc.enabledPlugins || {};

  if (on) {
    doc.env[p.envRouting] = p.proxyUrl;
    doc.enabledPlugins[p.plugin] = true;
    txn.note('ok', `HEADROOM routed via ${p.proxyUrl}`, USER_SETTINGS);
    txn.note('warn', 'HEADROOM disables /remote-control while routed', null);
    if (opts.startProxy !== false) txn.startProxy = true;
  } else {
    delete doc.env[p.envRouting];
    doc.enabledPlugins[p.plugin] = false;
    // Match the ensure-hook precisely. A loose "contains headroom" test would
    // also delete an unrelated hook that merely mentions a headroom path.
    const ENSURE = /headroom(\.exe)?["']?\s+init\s+hook\s+ensure/i;
    let removed = 0;
    for (const ev of Object.keys(doc.hooks || {})) {
      if (!Array.isArray(doc.hooks[ev])) continue;
      const before = doc.hooks[ev].length;
      doc.hooks[ev] = doc.hooks[ev].filter((g) => !ENSURE.test(JSON.stringify(g)));
      removed += before - doc.hooks[ev].length;
    }
    if (removed) txn.note('ok', `removed ${removed} headroom ensure-hook(s)`, USER_SETTINGS);
    txn.note('ok', 'HEADROOM routing removed, /remote-control works again', USER_SETTINGS);
    txn.stopProxy = true;
  }
}

// Build the plan without touching disk. This is what the UI previews.
function plan(changes) {
  const txn = new Txn();
  try {
    for (const [scopeId, sc] of Object.entries(changes || {})) {
      stageScope(txn, scopeId === 'global' ? null : scopeId, sc, { startProxy: false });
    }
  } catch (e) {
    return { ops: [{ level: 'error', msg: `cannot plan: ${e.message}`, file: e.file || null }], files: [], blocked: true };
  }
  const files = [];
  for (const [file, obj] of txn.docs) {
    const before = readJsonSoft(file, null);
    files.push({
      file,
      exists: fs.existsSync(file),
      before: before ? JSON.stringify(before, null, 2) : null,
      after: JSON.stringify(obj, null, 2),
    });
  }
  for (const [file, value] of txn.flags) {
    files.push({ file, exists: fs.existsSync(file), before: null, after: value === null ? '(deleted)' : value, isFlag: true });
  }
  return { ops: txn.ops, files };
}

function apply(changes, deps = {}) {
  const txn = new Txn();
  try {
    for (const [scopeId, sc] of Object.entries(changes || {})) {
      stageScope(txn, scopeId === 'global' ? null : scopeId, sc, {});
    }
  } catch (e) {
    return {
      ops: [{ level: 'error', msg: `refused, nothing written: ${e.message}`, file: e.file || null }],
      written: [], failed: true,
    };
  }
  let result;
  try {
    result = txn.commit(deps.watcher);
  } catch (e) {
    txn.note('error', `write failed, nothing else attempted: ${e.message}`, e.file || null);
    return { ops: txn.ops, written: [], failed: true };
  }
  if (txn.startProxy && deps.startProxy) deps.startProxy(txn);
  if (txn.stopProxy && deps.stopProxy) deps.stopProxy(txn);
  if (txn.ops.some((o) => o.level !== 'error')) {
    txn.note('info', 'restart Claude Code or run /reload-plugins, plugin state is not hot-reloaded', null);
  }
  return { ops: txn.ops, written: result.written, backupStamp: result.stamp, failed: false };
}

module.exports = { plan, apply, Txn };
