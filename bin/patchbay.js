#!/usr/bin/env node
'use strict';
// patchbay - zero-dependency local control panel for coding-agent personas.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const P = require('../src/personas');

const PUBLIC = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PATCHBAY_PORT || 41752);

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); }
    });
  });

const server = http.createServer(async (req, res) => {
  // Local-only tool: it writes to your config, so refuse anything not from loopback.
  const ip = req.socket.remoteAddress || '';
  if (!ip.includes('127.0.0.1') && !ip.includes('::1')) return send(res, 403, { error: 'loopback only' });

  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return send(res, 200, P.getState());
    }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      // toggle switch, drawn inline so the package stays file-light
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="7" fill="#2b2e33"/>
<rect x="4" y="10" width="24" height="12" rx="6" fill="#2c6b45"/>
<circle cx="22" cy="16" r="4.5" fill="#e2e5ea"/></svg>`;
      return send(res, 200, svg, 'image/svg+xml');
    }
    if (req.method === 'POST' && url.pathname === '/api/pick') {
      const picked = P.pickFolder();
      if (!picked) return send(res, 200, { cancelled: true });
      return send(res, 200, Object.assign({ picked }, P.setFolders(P.getFolders().concat([picked]))));
    }
    if (req.method === 'POST' && url.pathname === '/api/folders') {
      const body = await readBody(req);
      return send(res, 200, P.setFolders(body.folders || []));
    }
    if (req.method === 'POST' && url.pathname === '/api/apply') {
      const body = await readBody(req);
      const log = P.apply(body.changes || {});
      return send(res, 200, { log, state: P.getState() });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String(e && e.message ? e.message : e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`patchbay -> ${url}`);
  console.log(`config   -> ${P.CLAUDE_DIR}`);
  console.log('ctrl+c to stop');
  if (!process.argv.includes('--no-open')) {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch { /* open it yourself */ }
  }
});
