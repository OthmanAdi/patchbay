# HANDOFF

For the next agent session on patchbay. Written 2026-08-20.

## What this is

A local control panel for four Claude Code persona plugins. It reads the user's live
agent config, works out what is actually in effect for a given folder, explains why, and
writes the correct file when APPLY is pressed.

It writes production config. Treat every change as such.

## Run it

```bash
node bin/patchbay.js            # server + browser tab
node bin/patchbay.js app        # server + its own chrome-less window
node bin/patchbay.js --no-open  # server only (what a background instance uses)
node bin/patchbay.js autostart  # status; `on` / `off` to change. OFF by default.
npm test                        # 43 tests, node --test, no framework
```

Server is loopback-only on 41752. `PATCHBAY_PORT` and `CLAUDE_CONFIG_DIR` override.

## Architecture

| Module | Job |
|---|---|
| `src/paths.js` | every filesystem location, resolved once. `scopeFiles()` returns the three settings files in the order Claude Code applies them |
| `src/jsonio.js` | strict reads (malformed JSON throws with the path), atomic backed-up writes |
| `src/resolve.js` | the intelligence: `resolveEnabled` / `resolveLevel` return `{value, source, chain}` |
| `src/registry.js` | what each persona is and, critically, how each resolves its own settings |
| `src/state.js` | build the panel's view. Pure reads, nothing writes |
| `src/apply.js` | stage every change in one `Txn`, then write each file exactly once |
| `src/watch.js` | directory watching, debounce, echo suppression, state hash |
| `src/desktop.js` | app window, opt-in autostart, toasts. No native shell |
| `bin/patchbay.js` | http server, SSE stream, CLI |

## Invariants, do not break these

1. **Zero npm dependencies.** Node stdlib only. This is the project's identity and it
   satisfies the owner's supply-chain rule by construction. Do not add a package to save
   twenty lines.
2. **Never write from a bad read.** `Txn.doc()` uses the strict reader on purpose. A soft
   read that turned an unparseable `settings.json` into `{}` and wrote it back would
   replace the user's hooks, permissions and mcpServers. Regression-tested.
3. **One file, one write, per apply.** The original code did several independent
   read-modify-write cycles on the same file inside one loop and silently lost changes.
   Regression-tested.
4. **Autostart is opt-in.** Nothing may enable it as a side effect. It writes one
   shortcut to the per-user Startup folder, never a service or a machine-wide task.
5. **A scope path must be absolute and exist.** A relative path resolves against the
   server cwd and writes a settings file into a folder nobody meant to touch. This
   actually happened. Regression-tested.

## Things that are true and non-obvious

- **Narrower settings scope wins.** `enabledPlugins` is an ordinary key, so
  `<proj>/.claude/settings.local.json` beats `settings.json` beats `~/.claude/settings.json`.
  Only `permissions` merges.
- **caveman walks up from the cwd** looking for `.caveman/config.json`, so a level set on
  a parent folder applies to everything beneath. **ponytail does not** walk up at all.
  That asymmetry is real, read from each plugin's loader, and is tested.
- **A flag file is not configuration.** `.caveman-active` and `.ponytail-active` are
  rewritten from config at every SessionStart. `resolveLevel` reports them but never
  trusts them, and `flagDrift()` warns when they disagree.
- **i-have-adhd needs two things**: the plugin enabled AND `~/.claude/.i-have-adhd-always`
  present, because the skill is `disable-model-invocation`. Either alone does nothing.
- **Windows fs.watch**: watch the DIRECTORY, not the file. A file-bound watcher detaches
  silently on atomic replace (temp+rename), which is what editors and this app both do.
- **Nothing is hot-reloaded.** After APPLY the user must `/reload-plugins` or restart.

## Decided, do not relitigate without new information

**No native shell.** Researched 2026-08-20 across Tauri v2.11.5, Electron 42.x, MV3
extensions and the OS-primitive path.

The browser sandbox was never the constraint: the Node process already has full
filesystem, process and registry access. All three shells add presentation, not power.

- Tauri's headline 3MB assumes rewriting the backend in Rust (20-40h). A Node sidecar
  bundles a full `node.exe`, +90-110MB per target triple, so it costs Electron's size
  AND two toolchains. Worse on both axes.
- Electron is a 1-3 hour port but ships a private Chromium (~115MB) plus an 8-week
  security-patch treadmill, to toggle four config flags.
- An MV3 extension cannot read `~/.claude`, spawn a process, or watch files. The only
  bridge is Native Messaging, which means shipping a native binary anyway. Strictly worse
  than the status quo.

Revisit only if a tray icon or a global hotkey becomes the *primary* way the tool is used.
Those are the two gaps OS primitives genuinely cannot close. Then it is Tauri with a real
Rust rewrite, not a sidecar.

## Open items

- `~/.claude/.i-have-adhd-always` is missing on the owner's machine, so ADHD is enabled as
  a plugin but never fires. One click in the panel writes it. His call, not yours.
- Two early screenshots that exposed a full home path were removed from HEAD and purged
  from local history, but the blobs are still reachable on GitHub at commit `0794fe5`
  because force-push does not trigger GC there. Fixing it properly means deleting and
  recreating the repo, or asking GitHub Support. `docs/apply.png` still shows
  `C:\Users\oasrvadmin\.claude` in its header.
- Codex, OpenCode and Gemini are detected and displayed but not wired. The panel says so
  rather than pretending.
- Tray icon and global hotkey remain unimplemented, deliberately. See above.

## Owner preferences that apply here

Commits are authored by him alone, never a Co-Authored-By trailer. Prose in README and
commit messages avoids dashes as pauses. He wants the bold path surfaced before the
cautious one, and he would rather be told a number was wrong than be handed a confident
guess.
