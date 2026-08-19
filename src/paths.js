'use strict';
// Every filesystem location patchbay knows about, resolved once.
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const USER_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const CLAUDE_JSON = path.join(HOME, '.claude.json');
const PANEL_DIR = path.join(HOME, '.patchbay');
const FOLDERS_FILE = path.join(PANEL_DIR, 'folders.json');
const BACKUP_DIR = path.join(PANEL_DIR, 'backups');

const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const XDG = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');

// caveman and ponytail both read a user-level config, at a platform-specific path.
function userConfig(name) {
  return process.platform === 'win32'
    ? path.join(APPDATA, name, 'config.json')
    : path.join(XDG, name, 'config.json');
}

// Settings files for a project scope, in the order Claude Code applies them
// (later entries win). `null` folder means the user scope.
function scopeFiles(folder) {
  if (!folder) return [{ kind: 'user', file: USER_SETTINGS }];
  return [
    { kind: 'user', file: USER_SETTINGS },
    { kind: 'project', file: path.join(folder, '.claude', 'settings.json') },
    { kind: 'local', file: path.join(folder, '.claude', 'settings.local.json') },
  ];
}

// The file patchbay writes when you toggle something in a folder scope.
function writeTarget(folder) {
  return folder ? path.join(folder, '.claude', 'settings.local.json') : USER_SETTINGS;
}

module.exports = {
  HOME, CLAUDE_DIR, USER_SETTINGS, CLAUDE_JSON,
  PANEL_DIR, FOLDERS_FILE, BACKUP_DIR, APPDATA, XDG,
  userConfig, scopeFiles, writeTarget,
};
