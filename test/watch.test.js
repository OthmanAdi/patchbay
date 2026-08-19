'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ConfigWatcher, hashState } = require('../src/watch');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'patchbay-watch-'));
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test('hashState is stable across key order', () => {
  assert.equal(hashState({ a: 1, b: { x: 1, y: 2 } }), hashState({ b: { y: 2, x: 1 }, a: 1 }));
});

test('hashState changes when a value changes', () => {
  assert.notEqual(hashState({ a: 1 }), hashState({ a: 2 }));
});

test('one watcher per directory even with many files in it', () => {
  const dir = path.join(TMP, 'multi');
  fs.mkdirSync(dir, { recursive: true });
  const w = new ConfigWatcher();
  const n = w.setPaths([path.join(dir, 'a.json'), path.join(dir, 'b.json'), path.join(dir, 'c.json')]);
  assert.equal(n, 1, 'three files in one directory share a single watcher');
  w.close();
});

test('watchers for dropped paths are released', () => {
  const d1 = path.join(TMP, 'd1');
  const d2 = path.join(TMP, 'd2');
  fs.mkdirSync(d1, { recursive: true });
  fs.mkdirSync(d2, { recursive: true });
  const w = new ConfigWatcher();
  assert.equal(w.setPaths([path.join(d1, 'x.json'), path.join(d2, 'y.json')]), 2);
  assert.equal(w.setPaths([path.join(d1, 'x.json')]), 1, 'the removed folder stops being watched');
  w.close();
});

test('a file that does not exist yet is still covered once created', async () => {
  const dir = path.join(TMP, 'late');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'appears-later.json');
  const w = new ConfigWatcher();
  w.setPaths([target]);
  let fired = false;
  w.on('change', () => { fired = true; });
  fs.writeFileSync(target, '{"hello":1}');
  await settle(500);
  w.close();
  assert.ok(fired, 'creating the file fires a change');
});

test('a burst of writes coalesces into a single change event', async () => {
  const dir = path.join(TMP, 'burst');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'busy.json');
  fs.writeFileSync(target, '{}');
  const w = new ConfigWatcher();
  w.setPaths([target]);
  let count = 0;
  w.on('change', () => { count++; });
  for (let i = 0; i < 8; i++) fs.writeFileSync(target, JSON.stringify({ i }));
  await settle(600);
  w.close();
  assert.equal(count, 1, `eight writes produced ${count} events, expected 1`);
});

test('an atomic replace (temp + rename) is still detected', async () => {
  const dir = path.join(TMP, 'atomic');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'settings.json');
  fs.writeFileSync(target, '{"v":1}');
  const w = new ConfigWatcher();
  w.setPaths([target]);
  let fired = false;
  w.on('change', () => { fired = true; });
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, '{"v":2}');
  fs.renameSync(tmp, target);
  await settle(600);
  w.close();
  assert.ok(fired, 'watching the directory survives the rename');
});

test('our own writes emit self, not change', async () => {
  const dir = path.join(TMP, 'echo');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'own.json');
  fs.writeFileSync(target, '{}');
  const w = new ConfigWatcher();
  w.setPaths([target]);
  let changes = 0;
  let selfs = 0;
  w.on('change', () => { changes++; });
  w.on('self', () => { selfs++; });
  w.markSelfWrite();
  fs.writeFileSync(target, '{"mine":true}');
  await settle(600);
  w.close();
  assert.equal(changes, 0, 'no echo push for a write we made ourselves');
  assert.equal(selfs, 1);
});

test('close() releases every watcher', () => {
  const dir = path.join(TMP, 'closeall');
  fs.mkdirSync(dir, { recursive: true });
  const w = new ConfigWatcher();
  w.setPaths([path.join(dir, 'a.json')]);
  w.close();
  assert.equal(w.dirs.size, 0);
});
