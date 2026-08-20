#!/usr/bin/env node
'use strict';
// patchbay - zero-dependency local control panel for coding-agent personas.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const state = require('../src/state');
const { plan, apply } = require('../src/apply');
const { watchTargets } = require('../src/registry');
const { ConfigWatcher, hashState } = require('../src/watch');
const { CLAUDE_DIR } = require('../src/paths');
const desktop = require('../src/desktop');

const PUBLIC = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PATCHBAY_PORT || 41752);
const HEARTBEAT_MS = 25000; // below the usual 30s idle cut-off

const ARGV = process.argv.slice(2);
const WANT_APP = ARGV.includes('--app') || ARGV[0] === 'app';

// --- subcommands that never start a server ---------------------------------
if (ARGV[0] === 'autostart') {
  const verb = ARGV[1] || 'status';
  const report = (r) => {
    const s = desktop.autostartStatus();
    if (r && r.reason) console.error(`failed: ${r.reason}`);
    console.log(`start on login: ${s.enabled ? 'ENABLED' : 'disabled'}`);
    console.log(`shortcut      : ${s.link}`);
    if (!s.enabled) console.log('enable with: patchbay autostart on');
    process.exit(r && r.ok === false ? 1 : 0);
  };
  if (verb === 'on') desktop.enableAutostart(report);
  else if (verb === 'off') desktop.disableAutostart(report);
  else report(null);
  return;
}

if (ARGV[0] === 'help' || ARGV.includes('--help') || ARGV.includes('-h')) {
  console.log(`patchbay - persona control panel

  patchbay                 start the server and open it in your browser
  patchbay app             start the server and open it in its own window
  patchbay --no-open       start the server only
  patchbay autostart on    start on login (opt-in, per-user, no admin)
  patchbay autostart off   stop starting on login
  patchbay autostart       show whether it is enabled

env: PATCHBAY_PORT (default 41752), CLAUDE_CONFIG_DIR`);
  return;
}

const clients = new Set();
const watcher = new ConfigWatcher();
let lastHash = null;
let rebuilding = false;

// --- helpers ---------------------------------------------------------------
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > 2e6) req.destroy();
    });
    req.on('end', () => {
      try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); }
    });
  });

function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch { clients.delete(res); }
  }
}

// Rebuild state, rewire the watch set, and push only if something really moved.
async function refresh(reason, force = false) {
  if (rebuilding) return;
  rebuilding = true;
  try {
    const s = await state.getState();
    watcher.setPaths(watchTargets(s.scopes.filter((x) => x.path).map((x) => x.path)));
    const h = hashState(s);
    if (force || h !== lastHash) {
      lastHash = h;
      broadcast('state', { state: s, hash: h, reason: reason || 'refresh' });
    }
  } catch (e) {
    broadcast('error', { message: String((e && e.message) || e) });
  } finally {
    rebuilding = false;
  }
}

let lastToast = 0;
watcher.on('change', (reasons) => {
  const what = reasons.map((r) => path.basename(r)).join(', ');
  refresh(`changed: ${what}`);
  // One toast per 20s at most: a config edit can touch several files at once
  // and nobody wants four notifications for one save.
  if (Date.now() - lastToast > 20000) {
    lastToast = Date.now();
    desktop.toast('patchbay', `config changed on disk: ${what}`);
  }
});
watcher.on('self', () => refresh('applied by patchbay', true));

// --- proxy control ---------------------------------------------------------
function startProxy(txn) {
  let child;
  try {
    child = spawn('headroom', ['proxy', '--port', '8787', '--mode', 'cache'], {
      detached: true, stdio: 'ignore', shell: process.platform === 'win32',
    });
  } catch {
    broadcast('log', { level: 'error', msg: 'could not launch headroom, run "headroom proxy" yourself' });
    return;
  }
  // Without this listener an ENOENT from a missing binary is an unhandled
  // 'error' event, which takes the whole server down a tick after the response.
  child.on('error', (e) => {
    broadcast('log', { level: 'error', msg: `headroom proxy failed to start: ${e.message}` });
  });
  child.unref();
  broadcast('log', { level: 'info', msg: 'headroom proxy starting, allow ~10s' });
  setTimeout(() => refresh('proxy start', true), 9000);
}

function stopProxy() {
  const done = (ok) => {
    broadcast('log', {
      level: ok ? 'ok' : 'warn',
      msg: ok ? 'headroom proxy stopped' : 'routing removed; the proxy may still be running, stop it yourself',
    });
    refresh('proxy stop', true);
  };
  if (process.platform === 'win32') {
    execFile('powershell', ['-NoProfile', '-Command',
      "$c=Get-NetTCPConnection -LocalPort 8787 -State Listen -EA SilentlyContinue|Select-Object -First 1; if($c){Stop-Process -Id $c.OwningProcess -Force; exit 0}else{exit 1}"],
    { timeout: 15000 }, (err) => done(!err));
  } else {
    execFile('pkill', ['-f', 'headroom proxy'], { timeout: 10000 }, (err) => done(!err));
  }
}

// --- routes ----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // This writes to your agent config, so nothing but loopback gets in.
  const ip = req.socket.remoteAddress || '';
  if (!ip.includes('127.0.0.1') && !ip.includes('::1')) return send(res, 403, { error: 'loopback only' });

  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html')), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="7" fill="#2b2e33"/>
<rect x="4" y="10" width="24" height="12" rx="6" fill="#2c6b45"/>
<circle cx="22" cy="16" r="4.5" fill="#e2e5ea"/></svg>`;
      return send(res, 200, svg, 'image/svg+xml');
    }

    // Server-Sent Events: the panel's live link to disk.
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      clients.add(res);
      const s = await state.getState();
      lastHash = hashState(s);
      res.write(`event: state\ndata: ${JSON.stringify({ state: s, hash: lastHash, reason: 'hello' })}\n\n`);
      const hb = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { clearInterval(hb); }
      }, HEARTBEAT_MS);
      req.on('close', () => { clearInterval(hb); clients.delete(res); });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      return send(res, 200, await state.getState());
    }

    if (req.method === 'GET' && url.pathname === '/api/discover') {
      return send(res, 200, { candidates: state.discoverFolders() });
    }

    if (req.method === 'POST' && url.pathname === '/api/plan') {
      const body = await readBody(req);
      return send(res, 200, plan(body.changes || {}));
    }

    if (req.method === 'POST' && url.pathname === '/api/apply') {
      const body = await readBody(req);
      const result = apply(body.changes || {}, { watcher, startProxy, stopProxy });
      const s = await state.getState();
      lastHash = hashState(s);
      broadcast('state', { state: s, hash: lastHash, reason: 'applied' });
      return send(res, 200, { ...result, state: s });
    }

    if (req.method === 'GET' && url.pathname === '/api/desktop') {
      return send(res, 200, {
        autostart: desktop.autostartStatus(),
        browser: desktop.findBrowser(),
        port: PORT,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/autostart') {
      const body = await readBody(req);
      // Opt-in only. Nothing else in patchbay ever calls these.
      const done = (r) => {
        broadcast('log', {
          level: r.ok ? 'ok' : 'error',
          msg: r.ok
            ? (body.enabled ? `start on login ENABLED -> ${r.link}` : 'start on login DISABLED')
            : `could not change autostart: ${r.reason}`,
        });
        send(res, 200, { ...r, autostart: desktop.autostartStatus() });
      };
      return body.enabled ? desktop.enableAutostart(done) : desktop.disableAutostart(done);
    }

    if (req.method === 'POST' && url.pathname === '/api/openapp') {
      const r = desktop.openAppWindow(`http://127.0.0.1:${PORT}`);
      return send(res, 200, r);
    }

    if (req.method === 'POST' && url.pathname === '/api/pick') {
      const picked = pickFolder();
      if (!picked) return send(res, 200, { cancelled: true });
      const out = state.setFolders(state.getFolders().concat([picked]));
      await refresh('folder added', true);
      return send(res, 200, { picked, ...out });
    }

    if (req.method === 'POST' && url.pathname === '/api/folders') {
      const body = await readBody(req);
      const out = state.setFolders(body.folders || []);
      await refresh('folders changed', true);
      return send(res, 200, out);
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String((e && e.message) || e) });
  }
});

// --- native folder dialog --------------------------------------------------
function pickFolder() {
  const { execFileSync } = require('child_process');
  try {
    if (process.platform === 'win32') {
      // -STA is required for FolderBrowserDialog. The invisible TopMost form is
      // its owner, otherwise the dialog opens behind the browser window.
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
        "$d.Description = 'Pick a project folder for Patchbay'",
        '$d.ShowNewFolderButton = $false',
        '$owner = New-Object System.Windows.Forms.Form -Property @{TopMost=$true;ShowInTaskbar=$false;Opacity=0}',
        '$owner.Show(); $owner.Activate()',
        'if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }',
        '$owner.Close()',
      ].join('; ');
      return (execFileSync('powershell', ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
        { encoding: 'utf8', timeout: 300000, windowsHide: true }) || '').trim() || null;
    }
    if (process.platform === 'darwin') {
      return (execFileSync('osascript', ['-e', 'POSIX path of (choose folder with prompt "Pick a project folder for Patchbay")'],
        { encoding: 'utf8', timeout: 300000 }) || '').trim() || null;
    }
    return (execFileSync('zenity', ['--file-selection', '--directory', '--title=Pick a project folder for Patchbay'],
      { encoding: 'utf8', timeout: 300000 }) || '').trim() || null;
  } catch {
    return null; // cancelled, or no dialog on this box
  }
}

// --- boot ------------------------------------------------------------------
server.listen(PORT, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`patchbay -> ${url}`);
  console.log(`config   -> ${CLAUDE_DIR}`);
  console.log('ctrl+c to stop');
  await refresh('boot', true);
  if (process.argv.includes('--no-open')) return;
  if (WANT_APP) {
    const r = desktop.openAppWindow(url);
    if (r.ok) return;
    console.log(`(app window unavailable: ${r.reason})`);
  }
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch { /* open it yourself */ }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`port ${PORT} is already in use. Another patchbay is probably running: open http://127.0.0.1:${PORT}`);
    process.exit(1);
  }
  throw e;
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    watcher.close();
    for (const c of clients) { try { c.end(); } catch {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
