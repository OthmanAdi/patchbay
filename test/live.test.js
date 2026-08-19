'use strict';
// Integration test: boot the real server against a throwaway config dir, open
// the SSE stream, change a file on disk the way another Claude Code session
// would, and assert the panel is told about it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'patchbay-live-'));
const CLAUDE = path.join(TMP, 'claude');
const SETTINGS = path.join(CLAUDE, 'settings.json');
const PORT = 41000 + Math.floor(process.hrtime()[1] % 900);

fs.mkdirSync(CLAUDE, { recursive: true });
fs.writeFileSync(SETTINGS, JSON.stringify({ enabledPlugins: { 'caveman@caveman': false } }, null, 2));
fs.writeFileSync(path.join(TMP, '.claude.json'), JSON.stringify({ mcpServers: {}, projects: {} }));

function boot() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'patchbay.js'), '--no-open'], {
    env: {
      ...process.env,
      PATCHBAY_PORT: String(PORT),
      CLAUDE_CONFIG_DIR: CLAUDE,
      HOME: TMP,
      USERPROFILE: TMP,
      APPDATA: path.join(TMP, 'appdata'),
      XDG_CONFIG_HOME: path.join(TMP, 'xdg'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  child.on('exit', () => {});
  return { child, errText: () => err };
}

function waitFor(url, tries = 40) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      http.get(url, (res) => { res.resume(); resolve(); })
        .on('error', () => {
          if (n <= 0) return reject(new Error('server never came up'));
          setTimeout(() => attempt(n - 1), 150);
        });
    };
    attempt(tries);
  });
}

// Collect SSE `state` frames until `want` of them arrive or we time out.
function collectStates(want, ms) {
  return new Promise((resolve) => {
    const frames = [];
    const req = http.get(`http://127.0.0.1:${PORT}/api/stream`, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (raw.startsWith('event: state')) {
            const line = raw.split('\n').find((l) => l.startsWith('data: '));
            if (line) frames.push(JSON.parse(line.slice(6)));
            if (frames.length >= want) { req.destroy(); resolve(frames); return; }
          }
        }
      });
    });
    req.on('error', () => resolve(frames));
    setTimeout(() => { try { req.destroy(); } catch {} resolve(frames); }, ms);
  });
}

test('an external edit reaches the panel over SSE', async (t) => {
  const srv = boot();
  t.after(() => { try { srv.child.kill(); } catch {} });
  await waitFor(`http://127.0.0.1:${PORT}/api/state`);

  const got = collectStates(2, 8000);
  // give the stream a moment to register before touching disk
  await new Promise((r) => setTimeout(r, 400));

  // exactly what another session flipping a plugin would do
  fs.writeFileSync(SETTINGS, JSON.stringify({ enabledPlugins: { 'caveman@caveman': true } }, null, 2));

  const frames = await got;
  assert.ok(frames.length >= 1, 'the hello frame arrives on connect');
  assert.equal(frames[0].reason, 'hello');
  assert.equal(frames[0].state.scopes[0].personas.caveman.enabled.value, false, 'initial state is off');

  assert.ok(frames.length >= 2, `expected a pushed update, got ${frames.length} frame(s): ${srv.errText().slice(0, 300)}`);
  assert.equal(frames[1].state.scopes[0].personas.caveman.enabled.value, true, 'the push carries the new value');
  assert.match(frames[1].reason, /changed/, 'the push says what changed');
  assert.notEqual(frames[0].hash, frames[1].hash, 'the state hash moved');
});

test('an identical rewrite does not push a pointless update', async (t) => {
  const srv = boot();
  t.after(() => { try { srv.child.kill(); } catch {} });
  await waitFor(`http://127.0.0.1:${PORT}/api/state`);

  const body = fs.readFileSync(SETTINGS, 'utf8');
  const got = collectStates(2, 3500);
  await new Promise((r) => setTimeout(r, 400));
  fs.writeFileSync(SETTINGS, body); // same bytes, new mtime

  const frames = await got;
  assert.equal(frames.length, 1, 'only the hello frame, no push for an unchanged state');
});
