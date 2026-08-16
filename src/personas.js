'use strict';
// Persona registry + all filesystem reads/writes.
// Every path and resolution rule here was verified against the real plugin sources.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const PANEL_DIR = path.join(HOME, '.patchbay');
const FOLDERS_FILE = path.join(PANEL_DIR, 'folders.json');
const BACKUP_DIR = path.join(PANEL_DIR, 'backups');

const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const XDG = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
// caveman and ponytail read %APPDATA%\<name>\config.json on Windows,
// $XDG_CONFIG_HOME/<name>/config.json or ~/.config/<name>/config.json elsewhere.
const userCfg = (name) =>
  process.platform === 'win32'
    ? path.join(APPDATA, name, 'config.json')
    : path.join(XDG, name, 'config.json');

const PERSONAS = [
  {
    id: 'caveman',
    label: 'CAVEMAN',
    blurb: 'Cuts filler. Makes answers shorter.',
    plugin: 'caveman@caveman',
    levels: ['off', 'lite', 'full', 'ultra'],
    defaultLevel: 'full',
    flag: path.join(CLAUDE_DIR, '.caveman-active'),
    globalConfig: userCfg('caveman'),
    // caveman walks up from cwd looking for .caveman/config.json, so levels are per-folder too
    folderConfig: (dir) => path.join(dir, '.caveman', 'config.json'),
  },
  {
    id: 'ponytail',
    label: 'PONYTAIL',
    blurb: 'Lazy senior dev. Fights over-building.',
    plugin: 'ponytail@ponytail',
    levels: ['lite', 'full', 'ultra'],
    defaultLevel: 'full',
    flag: path.join(CLAUDE_DIR, '.ponytail-active'),
    globalConfig: userCfg('ponytail'),
    folderConfig: null, // ponytail has no repo-local config lookup
  },
  {
    id: 'i-have-adhd',
    label: 'I-HAVE-ADHD',
    blurb: 'Action first, numbered steps, keeps the thread.',
    plugin: 'i-have-adhd@i-have-adhd',
    levels: null, // binary
    flag: path.join(CLAUDE_DIR, '.i-have-adhd-always'),
    flagIsPresence: true, // file exists = always-on
    globalConfig: null,
    folderConfig: null,
  },
  {
    id: 'headroom',
    label: 'HEADROOM',
    blurb: 'Compression proxy. Global only. Disables /remote-control.',
    plugin: 'headroom@headroom-marketplace',
    levels: null,
    globalOnly: true,
    proxyUrl: 'http://127.0.0.1:8787',
  },
];

// ---------------------------------------------------------------- json helpers

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function backup(file) {
  if (!fs.existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(BACKUP_DIR, stamp);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(file, path.join(dir, path.basename(file)));
}

function writeJson(file, obj) {
  backup(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

// ---------------------------------------------------------------- folder list

function getFolders() {
  return readJson(FOLDERS_FILE, []);
}

function setFolders(list) {
  const clean = [...new Set(list.filter((f) => typeof f === 'string' && f.trim()))];
  fs.mkdirSync(PANEL_DIR, { recursive: true });
  fs.writeFileSync(FOLDERS_FILE, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

// ---------------------------------------------------------------- state reads

function proxyUp() {
  try {
    execFileSync(process.platform === 'win32' ? 'powershell' : 'sh',
      process.platform === 'win32'
        ? ['-NoProfile', '-Command', "if((Test-NetConnection 127.0.0.1 -Port 8787 -WarningAction SilentlyContinue).TcpTestSucceeded){exit 0}else{exit 1}"]
        : ['-c', 'nc -z 127.0.0.1 8787'],
      { stdio: 'ignore', timeout: 6000 });
    return true;
  } catch {
    return false;
  }
}

function isInstalled(p) {
  if (!p.plugin) return false;
  const [name, marketplace] = p.plugin.split('@');
  const dir = path.join(CLAUDE_DIR, 'plugins', 'cache', marketplace, name);
  return fs.existsSync(dir);
}

function readLevel(p, dir) {
  if (!p.levels) return null;
  if (dir && p.folderConfig) {
    const c = readJson(p.folderConfig(dir), null);
    if (c && c.defaultMode) return { value: c.defaultMode, from: 'folder' };
    return { value: null, from: 'inherit' };
  }
  const c = p.globalConfig ? readJson(p.globalConfig, null) : null;
  if (c && c.defaultMode) return { value: c.defaultMode, from: 'config' };
  const flag = p.flag && fs.existsSync(p.flag) ? fs.readFileSync(p.flag, 'utf8').trim() : null;
  return { value: flag || p.defaultLevel, from: flag ? 'flag (not durable)' : 'default' };
}

function scopeSettingsPath(dir) {
  return dir ? path.join(dir, '.claude', 'settings.local.json') : SETTINGS;
}

function readScope(dir) {
  const settings = readJson(scopeSettingsPath(dir), {});
  const enabled = settings.enabledPlugins || {};
  const globalEnabled = dir ? (readJson(SETTINGS, {}).enabledPlugins || {}) : enabled;
  const personas = {};

  for (const p of PERSONAS) {
    const own = Object.prototype.hasOwnProperty.call(enabled, p.plugin) ? enabled[p.plugin] : null;
    const effective = own === null ? !!globalEnabled[p.plugin] : own;
    const rec = {
      installed: isInstalled(p),
      enabled: effective,
      set: own,                       // null = inherits from global
      inherited: dir ? own === null : false,
      level: readLevel(p, dir),
      supported: !(dir && p.globalOnly),
      levelScoped: !dir || !!p.folderConfig,
    };
    if (p.id === 'i-have-adhd' && !dir) rec.alwaysOn = fs.existsSync(p.flag);
    if (p.id === 'headroom' && !dir) {
      const env = readJson(SETTINGS, {}).env || {};
      rec.routed = env.ANTHROPIC_BASE_URL === p.proxyUrl;
      rec.proxy = proxyUp();
      rec.enabled = rec.routed;
    }
    personas[p.id] = rec;
  }
  return { id: dir || 'global', label: dir || `GLOBAL  ${CLAUDE_DIR}`, path: dir, file: scopeSettingsPath(dir), personas };
}

function detectAgents() {
  return {
    'claude code': { present: fs.existsSync(SETTINGS), wired: true },
    codex: { present: fs.existsSync(path.join(HOME, '.codex')), wired: false },
    opencode: { present: fs.existsSync(path.join(XDG, 'opencode')) || fs.existsSync(path.join(HOME, '.opencode')), wired: false },
    gemini: { present: fs.existsSync(path.join(HOME, '.gemini')), wired: false },
  };
}

function getState() {
  const folders = getFolders();
  return {
    claudeDir: CLAUDE_DIR,
    personas: PERSONAS.map((p) => ({
      id: p.id, label: p.label, blurb: p.blurb, levels: p.levels,
      globalOnly: !!p.globalOnly, binary: !p.levels,
    })),
    scopes: [readScope(null), ...folders.map((f) => readScope(f))],
    agents: detectAgents(),
  };
}

// ---------------------------------------------------------------- state writes

function applyToScope(dir, changes) {
  const log = [];
  const file = scopeSettingsPath(dir);
  const settings = readJson(file, {});
  settings.enabledPlugins = settings.enabledPlugins || {};
  let touched = false;

  for (const [id, change] of Object.entries(changes)) {
    const p = PERSONAS.find((x) => x.id === id);
    if (!p) continue;
    if (dir && p.globalOnly) { log.push(`${p.label}: global only, skipped for ${dir}`); continue; }

    if (typeof change.enabled === 'boolean') {
      if (p.id === 'headroom') {
        log.push(...setHeadroom(change.enabled));
      } else {
        settings.enabledPlugins[p.plugin] = change.enabled;
        touched = true;
        log.push(`${p.label}: ${change.enabled ? 'ON' : 'OFF'} in ${path.basename(file)}`);
      }
      if (p.flagIsPresence && !dir) {
        if (change.enabled) { fs.mkdirSync(path.dirname(p.flag), { recursive: true }); fs.writeFileSync(p.flag, '1'); }
        else if (fs.existsSync(p.flag)) fs.unlinkSync(p.flag);
        log.push(`${p.label}: always-on flag ${change.enabled ? 'written' : 'removed'}`);
      }
    }

    if (change.level && p.levels) {
      if (dir && !p.folderConfig) { log.push(`${p.label}: level is global only, skipped for ${dir}`); continue; }
      const cfgPath = dir ? p.folderConfig(dir) : p.globalConfig;
      writeJson(cfgPath, { defaultMode: change.level });
      log.push(`${p.label}: level ${change.level} -> ${cfgPath}`);
      // keep the live flag in sync; SessionStart re-derives it from config anyway
      if (!dir && p.flag) { fs.writeFileSync(p.flag, change.level); log.push(`${p.label}: flag synced to ${change.level}`); }
    }
  }

  if (touched) writeJson(file, settings);
  return log;
}

function setHeadroom(on) {
  const log = [];
  const settings = readJson(SETTINGS, {});
  settings.env = settings.env || {};
  const p = PERSONAS.find((x) => x.id === 'headroom');

  if (on) {
    settings.env.ANTHROPIC_BASE_URL = p.proxyUrl;
    settings.enabledPlugins = settings.enabledPlugins || {};
    settings.enabledPlugins[p.plugin] = true;
    writeJson(SETTINGS, settings);
    log.push(`HEADROOM: routed via ${p.proxyUrl}`);
    if (!proxyUp()) {
      try {
        const child = spawn('headroom', ['proxy', '--port', '8787', '--mode', 'cache'], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
        child.unref();
        log.push('HEADROOM: proxy starting (give it ~10s)');
      } catch { log.push('HEADROOM: could not spawn proxy, run "headroom proxy" by hand'); }
    } else log.push('HEADROOM: proxy already up');
    log.push('HEADROOM: NOTE /remote-control is disabled while routed');
  } else {
    delete settings.env.ANTHROPIC_BASE_URL;
    if (settings.enabledPlugins) settings.enabledPlugins[p.plugin] = false;
    for (const ev of Object.keys(settings.hooks || {})) {
      const before = settings.hooks[ev].length;
      settings.hooks[ev] = settings.hooks[ev].filter((g) => !JSON.stringify(g).toLowerCase().includes('headroom'));
      if (settings.hooks[ev].length !== before) log.push(`HEADROOM: removed ${ev} ensure-hook`);
    }
    writeJson(SETTINGS, settings);
    log.push('HEADROOM: routing removed, /remote-control works again');
    try {
      if (process.platform === 'win32') {
        execFileSync('powershell', ['-NoProfile', '-Command',
          "$c=Get-NetTCPConnection -LocalPort 8787 -State Listen -EA SilentlyContinue|Select-Object -First 1; if($c){Stop-Process -Id $c.OwningProcess -Force}"],
          { stdio: 'ignore', timeout: 15000 });
      }
      log.push('HEADROOM: proxy stopped');
    } catch { log.push('HEADROOM: proxy was not running'); }
  }
  return log;
}

function apply(payload) {
  const log = [];
  for (const [scopeId, changes] of Object.entries(payload || {})) {
    log.push(...applyToScope(scopeId === 'global' ? null : scopeId, changes));
  }
  log.push('---');
  log.push('Restart Claude Code or run /reload-plugins. Plugin state is not hot-reloaded.');
  return log;
}

module.exports = { getState, apply, getFolders, setFolders, PERSONAS, CLAUDE_DIR };
