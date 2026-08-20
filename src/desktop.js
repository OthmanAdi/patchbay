'use strict';
// Desktop integration without a native shell.
//
// Everything here shells out to primitives Windows already ships. Nothing runs
// unless the user asks for it: autostart in particular is opt-in, off by
// default, and never enabled as a side effect of anything else.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const STARTUP_DIR = path.join(APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const LINK_NAME = 'patchbay.lnk';
const startupLink = () => path.join(STARTUP_DIR, LINK_NAME);

const entryScript = () => path.join(__dirname, '..', 'bin', 'patchbay.js');

// --- chrome-less window ----------------------------------------------------
// --app= gives the page its own window, its own taskbar entry and no browser
// chrome. It is the cheapest 90% of "looks like a desktop app".
const BROWSERS = [
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'Google', 'Chrome', 'Application', 'chrome.exe'),
];

function findBrowser() {
  for (const b of BROWSERS) if (fs.existsSync(b)) return b;
  return null;
}

// A dedicated profile dir keeps the app window out of the user's normal
// browser session, so closing their last tab cannot close patchbay.
function appProfileDir() {
  return path.join(HOME, '.patchbay', 'window-profile');
}

function openAppWindow(url) {
  const exe = findBrowser();
  if (!exe) return { ok: false, reason: 'no Edge or Chrome found, open the URL in any browser' };
  try {
    const child = spawn(exe, [
      `--app=${url}`,
      `--user-data-dir=${appProfileDir()}`,
      '--no-first-run',
      '--no-default-browser-check',
    ], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return { ok: true, exe };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// --- autostart (opt-in) ----------------------------------------------------
// A shortcut in the per-user Startup folder. No admin, no scheduled task, and
// the user can see and delete it in Explorer, which matters for something that
// launches itself.
function autostartStatus() {
  const link = startupLink();
  return {
    supported: process.platform === 'win32',
    enabled: fs.existsSync(link),
    link,
    folder: STARTUP_DIR,
  };
}

function enableAutostart(cb) {
  if (process.platform !== 'win32') return cb({ ok: false, reason: 'Windows only for now' });
  const link = startupLink();
  const target = process.execPath;             // node.exe
  const args = `"${entryScript()}" --no-open`; // headless: no browser popping up at login
  const ps = [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${link.replace(/'/g, "''")}')`,
    `$s.TargetPath = '${target.replace(/'/g, "''")}'`,
    `$s.Arguments = '${args.replace(/'/g, "''")}'`,
    `$s.WorkingDirectory = '${path.dirname(entryScript()).replace(/'/g, "''")}'`,
    '$s.WindowStyle = 7',
    "$s.Description = 'patchbay - persona control panel'",
    '$s.Save()',
  ].join('; ');
  try { fs.mkdirSync(STARTUP_DIR, { recursive: true }); } catch {}
  execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { timeout: 20000, windowsHide: true }, (err) => {
      if (err) return cb({ ok: false, reason: err.message });
      cb({ ok: fs.existsSync(link), link });
    });
}

function disableAutostart(cb) {
  const link = startupLink();
  try {
    if (fs.existsSync(link)) fs.unlinkSync(link);
    cb({ ok: !fs.existsSync(link), link });
  } catch (e) {
    cb({ ok: false, reason: e.message });
  }
}

// --- toasts ----------------------------------------------------------------
// WinRT toasts need Windows PowerShell 5.1 specifically: pwsh 7 dropped the
// WinRT projection these APIs rely on. Silent no-op everywhere else, because a
// notification failing is never worth interrupting the tool.
function toast(title, body) {
  if (process.platform !== 'win32') return;
  const esc = (s) => String(s).replace(/[<>&]/g, ' ').replace(/'/g, "''").slice(0, 300);
  const ps = `
$ErrorActionPreference='SilentlyContinue'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$n=$t.GetElementsByTagName('text')
$n.Item(0).AppendChild($t.CreateTextNode('${esc(title)}')) | Out-Null
$n.Item(1).AppendChild($t.CreateTextNode('${esc(body)}')) | Out-Null
$a='{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($a).Show([Windows.UI.Notifications.ToastNotification]::new($t))`;
  try {
    const child = execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: 15000, windowsHide: true }, () => {});
    child.on('error', () => {});
  } catch { /* notifications are decoration, never fatal */ }
}

module.exports = {
  openAppWindow, findBrowser, appProfileDir,
  autostartStatus, enableAutostart, disableAutostart, startupLink, STARTUP_DIR,
  toast,
};
