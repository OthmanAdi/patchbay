'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'patchbay-test-'));
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');
process.env.APPDATA = path.join(TMP, 'appdata');
process.env.XDG_CONFIG_HOME = path.join(TMP, 'xdg');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

const { resolveEnabled, resolveLevel, walkUpForConfig } = require('../src/resolve');
const { USER_SETTINGS } = require('../src/paths');

const write = (f, o) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(o, null, 2));
};
const mkProject = (name) => {
  const p = path.join(TMP, name);
  fs.mkdirSync(path.join(p, '.claude'), { recursive: true });
  return p;
};

test('user scope alone decides when no project file exists', () => {
  write(USER_SETTINGS, { enabledPlugins: { 'caveman@caveman': true } });
  const proj = mkProject('plain');
  const r = resolveEnabled(proj, 'caveman@caveman');
  assert.equal(r.value, true);
  assert.equal(r.source, 'user');
});

test('project settings.json overrides user scope', () => {
  write(USER_SETTINGS, { enabledPlugins: { 'caveman@caveman': true } });
  const proj = mkProject('proj-override');
  write(path.join(proj, '.claude', 'settings.json'), { enabledPlugins: { 'caveman@caveman': false } });
  const r = resolveEnabled(proj, 'caveman@caveman');
  assert.equal(r.value, false, 'narrower scope must win');
  assert.equal(r.source, 'project');
});

test('settings.local.json beats settings.json', () => {
  write(USER_SETTINGS, { enabledPlugins: { 'caveman@caveman': false } });
  const proj = mkProject('local-wins');
  write(path.join(proj, '.claude', 'settings.json'), { enabledPlugins: { 'caveman@caveman': false } });
  write(path.join(proj, '.claude', 'settings.local.json'), { enabledPlugins: { 'caveman@caveman': true } });
  const r = resolveEnabled(proj, 'caveman@caveman');
  assert.equal(r.value, true);
  assert.equal(r.source, 'local');
});

test('a project file that omits the key does not override', () => {
  write(USER_SETTINGS, { enabledPlugins: { 'ponytail@ponytail': true } });
  const proj = mkProject('partial');
  write(path.join(proj, '.claude', 'settings.local.json'), { enabledPlugins: { 'other@x': false } });
  const r = resolveEnabled(proj, 'ponytail@ponytail');
  assert.equal(r.value, true);
  assert.equal(r.source, 'user');
});

test('chain records every location consulted, in precedence order', () => {
  const proj = mkProject('chain');
  const r = resolveEnabled(proj, 'caveman@caveman');
  assert.deepEqual(r.chain.map((c) => c.kind), ['user', 'project', 'local']);
});

test('malformed project JSON is reported, not thrown', () => {
  write(USER_SETTINGS, { enabledPlugins: { 'caveman@caveman': true } });
  const proj = mkProject('broken');
  fs.writeFileSync(path.join(proj, '.claude', 'settings.local.json'), '{ not json');
  const r = resolveEnabled(proj, 'caveman@caveman');
  assert.equal(r.value, true, 'falls back to the last good scope');
  assert.ok(r.chain.some((c) => c.error), 'the bad file is flagged in the chain');
});

const CAVEMAN = {
  levels: ['off', 'lite', 'full', 'ultra'],
  defaultLevel: 'full',
  envModeKey: 'CAVEMAN_DEFAULT_MODE',
  configName: 'caveman',
  folderConfigNames: [path.join('.caveman', 'config.json'), '.caveman.json'],
};
const PONYTAIL = {
  levels: ['lite', 'full', 'ultra'],
  defaultLevel: 'full',
  envModeKey: 'PONYTAIL_DEFAULT_MODE',
  configName: 'ponytail',
  folderConfigNames: null,
};

test('level falls back to the plugin default with nothing configured', () => {
  const proj = mkProject('lvl-default');
  assert.equal(resolveLevel(proj, CAVEMAN).value, 'full');
});

test('user config sets the level', () => {
  write(path.join(process.env.APPDATA, 'caveman', 'config.json'), { defaultMode: 'lite' });
  const proj = mkProject('lvl-user');
  const r = resolveLevel(proj, CAVEMAN);
  assert.equal(r.value, 'lite');
  assert.equal(r.source, 'user');
});

test('repo-local .caveman/config.json beats the user config', () => {
  write(path.join(process.env.APPDATA, 'caveman', 'config.json'), { defaultMode: 'lite' });
  const proj = mkProject('lvl-repo');
  write(path.join(proj, '.caveman', 'config.json'), { defaultMode: 'ultra' });
  const r = resolveLevel(proj, CAVEMAN);
  assert.equal(r.value, 'ultra');
  assert.equal(r.source, 'repo');
});

test('caveman walks UP: a parent .caveman config applies to a subfolder', () => {
  const parent = mkProject('lvl-parent');
  write(path.join(parent, '.caveman', 'config.json'), { defaultMode: 'off' });
  const child = path.join(parent, 'a', 'b', 'c');
  fs.mkdirSync(child, { recursive: true });
  const r = resolveLevel(child, CAVEMAN);
  assert.equal(r.value, 'off');
  assert.equal(r.source, 'repo');
});

test('the NEAREST ancestor wins the walk', () => {
  const parent = mkProject('lvl-nearest');
  write(path.join(parent, '.caveman', 'config.json'), { defaultMode: 'off' });
  const child = path.join(parent, 'inner');
  write(path.join(child, '.caveman', 'config.json'), { defaultMode: 'ultra' });
  assert.equal(resolveLevel(child, CAVEMAN).value, 'ultra');
});

test('ponytail does NOT walk up, it has no repo-local lookup', () => {
  write(path.join(process.env.APPDATA, 'ponytail', 'config.json'), { defaultMode: 'lite' });
  const parent = mkProject('pony-nowalk');
  write(path.join(parent, '.ponytail', 'config.json'), { defaultMode: 'ultra' });
  const r = resolveLevel(path.join(parent, 'deep'), PONYTAIL);
  assert.equal(r.value, 'lite', 'repo config must be ignored for ponytail');
  assert.equal(r.source, 'user');
});

test('env var beats every file', () => {
  write(path.join(process.env.APPDATA, 'caveman', 'config.json'), { defaultMode: 'lite' });
  process.env.CAVEMAN_DEFAULT_MODE = 'ultra';
  const proj = mkProject('lvl-env');
  write(path.join(proj, '.caveman', 'config.json'), { defaultMode: 'off' });
  const r = resolveLevel(proj, CAVEMAN);
  assert.equal(r.value, 'ultra');
  assert.equal(r.source, 'env');
  delete process.env.CAVEMAN_DEFAULT_MODE;
});

test('the walk terminates at the drive root instead of looping', () => {
  const hits = walkUpForConfig(path.join(TMP, 'nothing', 'here'), ['.nonexistent-marker']);
  assert.deepEqual(hits, []);
});
