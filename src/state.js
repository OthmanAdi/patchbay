'use strict';
// Build the panel's view of the world. Pure reads: nothing here writes.
const fs = require('fs');
const path = require('path');
const net = require('net');
const { readJsonSoft } = require('./jsonio');
const { PERSONAS } = require('./registry');
const { resolveEnabled, resolveLevel, flagDrift } = require('./resolve');
const {
  CLAUDE_DIR, USER_SETTINGS, CLAUDE_JSON, PANEL_DIR, FOLDERS_FILE,
  XDG, HOME, scopeFiles, writeTarget,
} = require('./paths');

// --- tracked folders -------------------------------------------------------
// A scope must be an absolute path to a directory that exists. A relative path
// would resolve against the server's cwd and write a settings file into a
// folder nobody meant to touch.
function normalizeFolder(f) {
  if (typeof f !== 'string') return null;
  const t = f.trim().replace(/^["']+|["']+$/g, '');
  if (!t || !path.isAbsolute(t)) return null;
  try {
    if (!fs.statSync(t).isDirectory()) return null;
  } catch {
    return null;
  }
  return path.resolve(t);
}

function getFolders() {
  return (readJsonSoft(FOLDERS_FILE, []) || []).map(normalizeFolder).filter(Boolean);
}

function setFolders(list) {
  const rejected = [];
  const clean = [];
  for (const f of list || []) {
    const n = normalizeFolder(f);
    if (n) clean.push(n);
    else if (typeof f === 'string' && f.trim()) rejected.push(f.trim());
  }
  const unique = [...new Set(clean)];
  fs.mkdirSync(PANEL_DIR, { recursive: true });
  fs.writeFileSync(FOLDERS_FILE, JSON.stringify(unique, null, 2) + '\n');
  return { folders: unique, rejected };
}

// --- discovery -------------------------------------------------------------
// Claude Code records every folder you have opened. That is a far better
// signal for "folders this user actually works in" than scanning the disk.
function discoverFolders(limit = 40) {
  const cj = readJsonSoft(CLAUDE_JSON, {}) || {};
  const tracked = new Set(getFolders());
  const seen = new Set();
  const out = [];
  for (const key of Object.keys(cj.projects || {})) {
    const n = normalizeFolder(key.replace(/\//g, path.sep));
    if (!n || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    const hasClaude = fs.existsSync(path.join(n, '.claude'));
    const overrides = scopeFiles(n).slice(1).some((s) => {
      const j = readJsonSoft(s.file, null);
      return !!(j && j.enabledPlugins && Object.keys(j.enabledPlugins).length);
    });
    out.push({ path: n, tracked: tracked.has(n), hasClaude, overrides, name: path.basename(n) });
  }
  // folders that already override plugin settings are the interesting ones
  out.sort((a, b) => (b.overrides - a.overrides) || (b.hasClaude - a.hasClaude) || a.path.localeCompare(b.path));
  return out.slice(0, limit);
}

// --- probes ----------------------------------------------------------------
// Non-blocking TCP probe. The old implementation shelled out to PowerShell on
// every single state build, which cost hundreds of milliseconds per request.
function probePort(host, port, timeout = 300) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

function isInstalled(p) {
  if (!p.plugin) return false;
  const [name, marketplace] = p.plugin.split('@');
  return fs.existsSync(path.join(CLAUDE_DIR, 'plugins', 'cache', marketplace, name));
}

// --- the state -------------------------------------------------------------
function buildScope(folder, ctx) {
  const personas = {};
  for (const p of PERSONAS) {
    const supported = !(folder && p.globalOnly);
    const rec = {
      installed: isInstalled(p),
      supported,
      levelScoped: !folder || !!p.folderConfigNames,
    };

    if (p.flagIsPresence) {
      // presence of the flag is the real switch for this one
      const on = fs.existsSync(p.flag);
      const en = resolveEnabled(folder, p.plugin);
      rec.enabled = { value: en.value && (folder ? true : on), source: on ? en.source : 'flag', chain: en.chain };
      rec.alwaysOn = on;
    } else {
      rec.enabled = resolveEnabled(folder, p.plugin);
    }

    rec.level = resolveLevel(folder, p);
    rec.drift = p.flagIsPresence ? null : flagDrift(p, rec.level);

    if (p.envKey && !folder) {
      const env = (ctx.userSettings.env) || {};
      rec.env = Object.prototype.hasOwnProperty.call(env, p.envKey) ? env[p.envKey] : null;
    }
    if (p.id === 'headroom' && !folder) {
      const env = ctx.userSettings.env || {};
      rec.routed = env[p.envRouting] === p.proxyUrl;
      rec.proxy = ctx.proxyUp;
      rec.enabled = { value: rec.routed, source: rec.routed ? 'env' : 'default', chain: rec.enabled.chain };
    }
    personas[p.id] = rec;
  }

  const active = Object.entries(personas)
    .filter(([, v]) => v.enabled && v.enabled.value && v.supported).length;

  return {
    id: folder || 'global',
    label: folder || `GLOBAL  ${CLAUDE_DIR}`,
    path: folder,
    name: folder ? path.basename(folder) : 'GLOBAL',
    writeTarget: writeTarget(folder),
    files: scopeFiles(folder).map((s) => ({ ...s, exists: fs.existsSync(s.file) })),
    activeCount: active,
    personas,
  };
}

function detectAgents() {
  return {
    'claude code': { present: fs.existsSync(USER_SETTINGS), wired: true },
    codex: { present: fs.existsSync(path.join(HOME, '.codex')), wired: false },
    opencode: { present: fs.existsSync(path.join(XDG, 'opencode')) || fs.existsSync(path.join(HOME, '.opencode')), wired: false },
    gemini: { present: fs.existsSync(path.join(HOME, '.gemini')), wired: false },
  };
}

async function getState() {
  const folders = getFolders();
  const userSettings = readJsonSoft(USER_SETTINGS, {}) || {};
  const proxyUp = await probePort('127.0.0.1', 8787);
  const ctx = { userSettings, proxyUp };

  const warnings = [];
  for (const { file } of scopeFiles(null)) {
    try { require('./jsonio').readJson(file, {}); } catch (e) { warnings.push(e.message); }
  }

  return {
    claudeDir: CLAUDE_DIR,
    personas: PERSONAS.map((p) => ({
      id: p.id, label: p.label, blurb: p.blurb, levels: p.levels,
      globalOnly: !!p.globalOnly, binary: !p.levels, cost: p.cost || null,
      envKey: p.envKey || null, envLabel: p.envLabel || null, envPresets: p.envPresets || null,
      walksUp: !!p.folderConfigNames,
    })),
    scopes: [buildScope(null, ctx), ...folders.map((f) => buildScope(f, ctx))],
    agents: detectAgents(),
    warnings,
  };
}

module.exports = { getState, getFolders, setFolders, normalizeFolder, discoverFolders, probePort };
