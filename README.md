# PATCHBAY

A studio rack for your coding agent's personality.

Four persona plugins (`caveman`, `ponytail`, `i-have-adhd`, `headroom`) each live in a
different file, use a different flag, and resolve their settings in a different order.
Turning one off for one project means hand-editing JSON in three places and remembering
which scope wins. Patchbay puts them behind toggle switches, shows what is actually
wired per folder, and writes the real files when you hit APPLY.

Zero dependencies. Local only. Node 18+.

```bash
npx github:OthmanAdi/patchbay
```

Opens `http://127.0.0.1:41752`.

## What it does

- Reads the true state, not what you think you configured: plugin enablement, level
  config files, flag files, and whether the headroom proxy is actually listening.
- Per-folder scopes. Add any project path and toggle a persona there without touching
  your global config. Career folder with caveman off, code repo with it on.
- Shows inheritance honestly. A folder that sets nothing says `inherits global`.
- Writes level changes to the config file, not just the flag file, so they survive a
  session restart. The flag alone gets overwritten at SessionStart.
- Backs up every file it touches to `~/.patchbay/backups/<timestamp>/` before writing.

## Personas

| Persona | Levels | Scope | What it changes |
|---|---|---|---|
| caveman | off, lite, full, ultra | global + per folder | Cuts filler. Shorter answers. |
| ponytail | lite, full, ultra | enable per folder, level global only | Lazy senior dev. Fights over-building. |
| i-have-adhd | none | global + per folder | Action first, numbered steps, keeps the thread across turns. |
| headroom | none | global only | Compression proxy. Also disables `/remote-control` while routed. |

The scope differences are not arbitrary, they are what each plugin actually supports.
Caveman walks up from the cwd looking for `.caveman/config.json`, so its level is
per-folder. Ponytail only reads a user-level config, so its level is global. Patchbay
greys out what the plugin cannot do rather than pretending.

## Where things live

| | Path |
|---|---|
| Plugin on/off | `~/.claude/settings.json` → `enabledPlugins` (global), `<project>/.claude/settings.local.json` (folder) |
| caveman level | `%APPDATA%\caveman\config.json`, or `<project>/.caveman/config.json` |
| ponytail level | `%APPDATA%\ponytail\config.json` |
| adhd always-on | `~/.claude/.i-have-adhd-always` |
| headroom routing | `~/.claude/settings.json` → `env.ANTHROPIC_BASE_URL` |
| tracked folders | `~/.patchbay/folders.json` |

On macOS and Linux the two `%APPDATA%` paths become `$XDG_CONFIG_HOME/<name>/config.json`
or `~/.config/<name>/config.json`.

## Two things worth knowing

**Nothing is hot-reloaded.** Plugin enablement is resolved once per session. After APPLY,
run `/reload-plugins` or start a new session.

**Narrower scope wins.** `enabledPlugins` is a normal settings key, so
`settings.local.json` in a project overrides your global `settings.json`. Only
`permissions` merges across scopes. That is why a plugin can look enabled globally and
still be dead in one repo.

## Agent support

Claude Code is wired. Codex, OpenCode and Gemini CLI are detected and shown, but writing
their configs is not implemented, and the panel says so rather than silently doing
nothing.

## Security

The server binds `127.0.0.1` and refuses non-loopback requests. It writes to your agent
config, so do not expose the port.

MIT.
