'use strict';
// Autostart is the one feature here that touches the machine outside patchbay's
// own directories, so the tests are mostly about it staying OFF unless asked.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'patchbay-desktop-'));
process.env.APPDATA = path.join(TMP, 'appdata');
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;

const desktop = require('../src/desktop');

test('autostart is off by default and nothing is created just by asking', () => {
  const s = desktop.autostartStatus();
  assert.equal(s.enabled, false);
  assert.ok(!fs.existsSync(s.link), 'no shortcut exists');
  assert.ok(!fs.existsSync(s.folder), 'merely reading status does not create the Startup folder');
});

test('the shortcut path is the per-user Startup folder, never a machine-wide one', () => {
  const s = desktop.autostartStatus();
  assert.match(s.link, /Start Menu[\\/]Programs[\\/]Startup[\\/]patchbay\.lnk$/);
  assert.ok(s.link.startsWith(process.env.APPDATA), 'stays under the user profile, so no admin is needed');
});

test('disabling when it was never enabled is a no-op that still reports success', (t, done) => {
  desktop.disableAutostart((r) => {
    assert.equal(r.ok, true);
    assert.ok(!fs.existsSync(r.link));
    done();
  });
});

test('the app window uses its own browser profile, not the user session', () => {
  const p = desktop.appProfileDir();
  assert.ok(p.includes('.patchbay'), 'isolated profile under ~/.patchbay');
  assert.ok(!fs.existsSync(p), 'not created until an app window is actually opened');
});

test('openAppWindow reports a reason instead of throwing when no browser is found', () => {
  const real = desktop.findBrowser();
  if (real) return; // a browser is installed here, nothing to assert
  const r = desktop.openAppWindow('http://127.0.0.1:1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /browser/i);
});

test('toast never throws, whatever it is handed', () => {
  assert.doesNotThrow(() => desktop.toast('t', 'body'));
  assert.doesNotThrow(() => desktop.toast('', ''));
  assert.doesNotThrow(() => desktop.toast("quote'and<tags>", 'x'.repeat(5000)));
});
