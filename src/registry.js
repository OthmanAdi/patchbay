'use strict';
// What each persona is and, more importantly, how each one actually resolves
// its own settings. The differences here are not arbitrary: they were read out
// of each plugin's own config loader.
const path = require('path');
const { CLAUDE_DIR } = require('./paths');

const PERSONAS = [
  {
    id: 'caveman',
    label: 'CAVEMAN',
    blurb: 'Cuts filler. Makes answers shorter.',
    plugin: 'caveman@caveman',
    levels: ['off', 'lite', 'full', 'ultra'],
    defaultLevel: 'full',
    flag: path.join(CLAUDE_DIR, '.caveman-active'),
    configName: 'caveman',
    envModeKey: 'CAVEMAN_DEFAULT_MODE',
    // its loader walks up from the cwd, so a level set on a parent folder
    // applies to everything beneath it
    folderConfigNames: [path.join('.caveman', 'config.json'), '.caveman.json'],
    cost: { session: 1040, perTurn: 15 },
  },
  {
    id: 'ponytail',
    label: 'PONYTAIL',
    blurb: 'Lazy senior dev. Fights over-building.',
    plugin: 'ponytail@ponytail',
    levels: ['lite', 'full', 'ultra'],
    defaultLevel: 'full',
    flag: path.join(CLAUDE_DIR, '.ponytail-active'),
    configName: 'ponytail',
    envModeKey: 'PONYTAIL_DEFAULT_MODE',
    folderConfigNames: null, // no repo-local lookup at all
    cost: { session: 1306, perSubagent: 1355 },
    envKey: 'PONYTAIL_SUBAGENT_MATCHER',
    envLabel: 'SUBAGENT INJECTION (~1.4k tok each)',
    envPresets: [
      { label: 'ALL', value: null, hint: 'every subagent pays it' },
      { label: 'NONE', value: '^$', hint: 'no subagent pays it' },
      { label: 'GENERAL', value: 'general', hint: 'general-purpose agents only' },
    ],
  },
  {
    id: 'i-have-adhd',
    label: 'I-HAVE-ADHD',
    blurb: 'Action first, numbered steps, keeps the thread.',
    plugin: 'i-have-adhd@i-have-adhd',
    levels: null,
    // the skill is disable-model-invocation, so it only runs at all when this
    // flag file exists; presence IS the setting, not just live state
    flag: path.join(CLAUDE_DIR, '.i-have-adhd-always'),
    flagIsPresence: true,
    cost: { session: 1683 },
  },
  {
    id: 'headroom',
    label: 'HEADROOM',
    blurb: 'Compression proxy. Global only. Disables /remote-control.',
    plugin: 'headroom@headroom-marketplace',
    levels: null,
    globalOnly: true,
    proxyUrl: 'http://127.0.0.1:8787',
    envRouting: 'ANTHROPIC_BASE_URL',
  },
];

const byId = (id) => PERSONAS.find((p) => p.id === id) || null;

// Everything whose change should refresh the panel.
function watchTargets(folders) {
  const { USER_SETTINGS, CLAUDE_JSON, userConfig } = require('./paths');
  const out = [USER_SETTINGS, CLAUDE_JSON];
  for (const p of PERSONAS) {
    if (p.flag) out.push(p.flag);
    if (p.configName) out.push(userConfig(p.configName));
  }
  for (const f of folders || []) {
    out.push(path.join(f, '.claude', 'settings.json'));
    out.push(path.join(f, '.claude', 'settings.local.json'));
    for (const p of PERSONAS) {
      for (const rel of p.folderConfigNames || []) out.push(path.join(f, rel));
    }
  }
  return [...new Set(out)];
}

module.exports = { PERSONAS, byId, watchTargets };
