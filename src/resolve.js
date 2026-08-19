'use strict';
// The intelligence of patchbay: work out what is ACTUALLY in effect for a
// folder, and be able to explain why. Every resolver returns a `chain` listing
// each location consulted in precedence order, so the UI can render the reason
// instead of asserting a bare answer.
const fs = require('fs');
const path = require('path');
const { readJsonSoft, readJson } = require('./jsonio');
const { scopeFiles, userConfig } = require('./paths');

// --- plugin enablement -----------------------------------------------------
// enabledPlugins is an ordinary settings key, so it follows strict override:
// managed > CLI > <proj>/.claude/settings.local.json > <proj>/.claude/settings.json
// > ~/.claude/settings.json. Only `permissions` merges across scopes.
// Later entries in scopeFiles() win.
function resolveEnabled(folder, pluginId) {
  const chain = [];
  let value = false;
  let source = 'default';

  for (const { kind, file } of scopeFiles(folder)) {
    let says = null;
    let error = null;
    if (fs.existsSync(file)) {
      let j;
      try {
        j = readJson(file, {});
      } catch (e) {
        error = e.message;
        j = null;
      }
      const ep = j && j.enabledPlugins;
      if (ep && Object.prototype.hasOwnProperty.call(ep, pluginId)) says = !!ep[pluginId];
    }
    chain.push({ kind, file, says, exists: fs.existsSync(file), error });
    if (says !== null) {
      value = says;
      source = kind;
    }
  }
  return { value, source, chain };
}

// --- persona level ---------------------------------------------------------
// caveman walks UP from the working directory looking for a repo-local config,
// so a level set in a parent folder applies to everything beneath it. ponytail
// has no repo-local lookup at all. Encoding that difference is the whole point.
function walkUpForConfig(folder, fileNames, limit = 40) {
  const found = [];
  let dir = path.resolve(folder);
  let prev = null;
  let steps = 0;
  while (dir && dir !== prev && steps++ < limit) {
    for (const rel of fileNames) {
      const candidate = path.join(dir, rel);
      if (fs.existsSync(candidate)) found.push({ dir, file: candidate });
    }
    prev = dir;
    dir = path.dirname(dir);
  }
  return found; // nearest first
}

function resolveLevel(folder, persona) {
  const chain = [];
  if (!persona.levels) return { value: null, source: 'n/a', chain };

  // 1. environment variable beats every file
  const envVal = persona.envModeKey ? process.env[persona.envModeKey] : undefined;
  chain.push({ kind: 'env', file: persona.envModeKey || '(none)', says: envVal || null, exists: !!envVal });
  if (envVal && persona.levels.includes(envVal)) {
    return { value: envVal, source: 'env', chain };
  }

  // 2. repo-local config, nearest ancestor wins (caveman only)
  if (folder && persona.folderConfigNames) {
    const hits = walkUpForConfig(folder, persona.folderConfigNames);
    for (const h of hits) {
      const mode = (readJsonSoft(h.file, {}) || {}).defaultMode || null;
      chain.push({ kind: 'repo', file: h.file, says: mode, exists: true });
    }
    const nearest = chain.find((c) => c.kind === 'repo' && c.says);
    if (nearest) return { value: nearest.says, source: 'repo', chain };
    if (!hits.length) {
      chain.push({ kind: 'repo', file: `${folder}\${persona.folderConfigNames[0]} (and parents)`, says: null, exists: false });
    }
  }

  // 3. user-level config
  const uc = persona.configName ? userConfig(persona.configName) : null;
  if (uc) {
    const mode = (readJsonSoft(uc, {}) || {}).defaultMode || null;
    chain.push({ kind: 'user', file: uc, says: mode, exists: fs.existsSync(uc) });
    if (mode) return { value: mode, source: 'user', chain };
  }

  // 4. the flag file is live session state, not durable configuration. It is
  // rewritten from the above at every SessionStart, so it is reported but never
  // treated as the source of truth.
  if (persona.flag) {
    let flagVal = null;
    try { flagVal = fs.readFileSync(persona.flag, 'utf8').trim() || null; } catch {}
    chain.push({ kind: 'flag', file: persona.flag, says: flagVal, exists: !!flagVal, volatile: true });
  }

  chain.push({ kind: 'default', file: '(plugin built-in)', says: persona.defaultLevel, exists: true });
  return { value: persona.defaultLevel, source: 'default', chain };
}

// A flag whose value disagrees with what the config resolves to is the classic
// "I set lite but it says full" trap: it will be silently overwritten at the
// next SessionStart.
function flagDrift(persona, resolved) {
  if (!persona.flag || !resolved || !resolved.value) return null;
  let live = null;
  try { live = fs.readFileSync(persona.flag, 'utf8').trim(); } catch { return null; }
  if (!live || live === resolved.value) return null;
  return { live, resolved: resolved.value, file: persona.flag };
}

module.exports = { resolveEnabled, resolveLevel, walkUpForConfig, flagDrift };
