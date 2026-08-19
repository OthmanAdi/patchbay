'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'patchbay-apply-'));
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');
process.env.APPDATA = path.join(TMP, 'appdata');
process.env.XDG_CONFIG_HOME = path.join(TMP, 'xdg');
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

const { apply, plan } = require('../src/apply');
const { USER_SETTINGS } = require('../src/paths');

const readUser = () => JSON.parse(fs.readFileSync(USER_SETTINGS, 'utf8'));
const writeUser = (o) => {
  fs.mkdirSync(path.dirname(USER_SETTINGS), { recursive: true });
  fs.writeFileSync(USER_SETTINGS, JSON.stringify(o, null, 2));
};
const mkProject = (name) => {
  const p = path.join(TMP, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

test('REGRESSION: a toggle and an env change in one batch both survive', () => {
  // The old code read settings once, and the env branch did its own
  // read-modify-write, so the final write clobbered the env change.
  writeUser({
    enabledPlugins: { 'ponytail@ponytail': false },
    env: {},
    hooks: { Stop: [{ hooks: [{ command: 'keep-me' }] }] },
    permissions: { allow: ['Bash(ls:*)'] },
  });
  const r = apply({ global: { ponytail: { enabled: true, env: '^$' } } });
  assert.equal(r.failed, false);
  const after = readUser();
  assert.equal(after.enabledPlugins['ponytail@ponytail'], true, 'toggle survived');
  assert.equal(after.env.PONYTAIL_SUBAGENT_MATCHER, '^$', 'env change survived');
});

test('unrelated keys in settings.json are preserved byte for byte', () => {
  writeUser({
    enabledPlugins: { 'caveman@caveman': false },
    hooks: { Stop: [{ hooks: [{ command: 'precious' }] }] },
    permissions: { allow: ['Bash(git:*)'], deny: [] },
    model: 'opus',
    statusLine: { type: 'command', command: 'x.ps1' },
  });
  apply({ global: { caveman: { enabled: true } } });
  const after = readUser();
  assert.deepEqual(after.hooks, { Stop: [{ hooks: [{ command: 'precious' }] }] });
  assert.deepEqual(after.permissions, { allow: ['Bash(git:*)'], deny: [] });
  assert.equal(after.model, 'opus');
  assert.deepEqual(after.statusLine, { type: 'command', command: 'x.ps1' });
});

test('REGRESSION: malformed settings.json is refused, never overwritten', () => {
  const corrupt = '{ "enabledPlugins": { broken';
  fs.writeFileSync(USER_SETTINGS, corrupt);
  const r = apply({ global: { caveman: { enabled: true } } });
  assert.equal(r.failed, true, 'apply must refuse');
  assert.match(r.ops[0].msg, /refused/i);
  assert.equal(fs.readFileSync(USER_SETTINGS, 'utf8'), corrupt, 'the file is untouched');
});

test('a folder scope writes settings.local.json and never the user file', () => {
  writeUser({ enabledPlugins: { 'caveman@caveman': true } });
  const proj = mkProject('scoped');
  const before = fs.readFileSync(USER_SETTINGS, 'utf8');
  const r = apply({ [proj]: { caveman: { enabled: false } } });
  assert.equal(r.failed, false);
  const local = JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'settings.local.json'), 'utf8'));
  assert.equal(local.enabledPlugins['caveman@caveman'], false);
  assert.equal(fs.readFileSync(USER_SETTINGS, 'utf8'), before, 'user scope untouched');
});

test('a relative folder path is refused and writes nothing', () => {
  const r = apply({ Documents: { caveman: { enabled: false } } });
  assert.equal(r.written.length, 0);
  assert.ok(r.ops.some((o) => o.level === 'error' && /absolute path/.test(o.msg)));
});

test('an invalid regex is rejected without poisoning env', () => {
  writeUser({ enabledPlugins: {}, env: { KEEP: '1' } });
  const r = apply({ global: { ponytail: { env: '[unclosed' } } });
  assert.ok(r.ops.some((o) => o.level === 'error' && /not a valid regex/.test(o.msg)));
  assert.equal(readUser().env.KEEP, '1');
  assert.equal(readUser().env.PONYTAIL_SUBAGENT_MATCHER, undefined);
});

test('an unknown level is rejected', () => {
  writeUser({ enabledPlugins: {} });
  const r = apply({ global: { caveman: { level: 'banana' } } });
  assert.ok(r.ops.some((o) => o.level === 'error' && /not one of/.test(o.msg)));
});

test('caveman level in a folder writes .caveman/config.json there', () => {
  writeUser({ enabledPlugins: {} });
  const proj = mkProject('lvl');
  const r = apply({ [proj]: { caveman: { level: 'ultra' } } });
  assert.equal(r.failed, false);
  const cfg = JSON.parse(fs.readFileSync(path.join(proj, '.caveman', 'config.json'), 'utf8'));
  assert.equal(cfg.defaultMode, 'ultra');
});

test('ponytail level in a folder is refused, since its loader ignores repo config', () => {
  writeUser({ enabledPlugins: {} });
  const proj = mkProject('pony-lvl');
  const r = apply({ [proj]: { ponytail: { level: 'ultra' } } });
  assert.ok(r.ops.some((o) => o.level === 'warn' && /global only/.test(o.msg)));
  assert.ok(!fs.existsSync(path.join(proj, '.ponytail')));
});

test('headroom off removes only its own ensure-hook, not lookalikes', () => {
  writeUser({
    enabledPlugins: { 'headroom@headroom-marketplace': true },
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' },
    hooks: {
      PreToolUse: [
        { hooks: [{ command: 'C:/bin/headroom.EXE init hook ensure --profile init-user' }] },
        { hooks: [{ command: 'node C:/work/headroom-experiments/build.js' }] },
      ],
    },
  });
  apply({ global: { headroom: { enabled: false } } });
  const after = readUser();
  assert.equal(after.hooks.PreToolUse.length, 1, 'exactly one hook removed');
  assert.match(after.hooks.PreToolUse[0].hooks[0].command, /headroom-experiments/, 'the unrelated hook survived');
  assert.equal(after.env.ANTHROPIC_BASE_URL, undefined);
});

test('plan() previews without touching disk', () => {
  writeUser({ enabledPlugins: { 'caveman@caveman': false } });
  const before = fs.readFileSync(USER_SETTINGS, 'utf8');
  const p = plan({ global: { caveman: { enabled: true } } });
  assert.ok(p.files.length >= 1);
  assert.ok(p.files[0].after.includes('"caveman@caveman": true'));
  assert.equal(fs.readFileSync(USER_SETTINGS, 'utf8'), before, 'plan is read-only');
});

test('every write leaves a backup behind', () => {
  writeUser({ enabledPlugins: { 'caveman@caveman': false } });
  const r = apply({ global: { caveman: { enabled: true } } });
  const dir = path.join(TMP, '.patchbay', 'backups', r.backupStamp);
  assert.ok(fs.existsSync(dir), 'backup directory exists');
  assert.ok(fs.readdirSync(dir).length > 0, 'backup file written');
});
