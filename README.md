# ext-guard

One broken extension must not take pi down with it.

## The failure it exists for

```
$ pi
Error: Failed to load extension "/home/…/.pi/agent/extensions/safety-classifier/index.ts": Failed to load extension: EDQUOT: unknown error, write
Hint: Start without extensions using "pi -ne".
```

pi loads every extension, and if any one of them throws, `main.js` reports the
failure and calls `process.exit(1)`. One unparseable file, one missing
dependency, one full `/tmp` — and the whole editor is gone, with a hint that also
throws away the extensions that were working.

`EDQUOT` in that message is usually not a broken extension at all: jiti writes a
transform cache for every TypeScript extension under `os.tmpdir()/jiti` (or a
`node_modules/.cache/jiti` beside it), and a full tmpfs fails the write. The
guard tells you when that is what happened, but the disk still needs freeing.

## What it does

Two layers. Neither deletes, renames or edits an extension.

**1. Startup.** `console.error` and `process.exit` are wrapped while the
extensions load. When pi reports `Failed to load extension "<path>": <err>` and
then exits with 1, the guard records the path, disables that extension, prints
what it did and lets the launch continue — but only when that exit really is
the one that followed the failure. Three things have to line up:

- every error pi reported is an extension load failure, and
- nothing was printed after the failures that is not part of the same
  diagnostic batch (pi prints the failures, the warnings and the yellow `-ne`
  hint, then exits, all in one synchronous block), and
- the exit follows within a few seconds of the report.

Any other fatal error, or an exit that comes later and belongs to something
else, is passed straight through to pi. The wrappers are removed the moment they
are used, so no later `process.exit` in the session is affected.

**2. Runtime.** An `uncaughtException` / `unhandledRejection` whose stack points
into a known extension file is attributed to that extension: it is disabled and
the session continues. A crash that cannot be attributed to an extension is left
to kill pi exactly as before — the guard prints it and exits 1.

## How "disabled" works

The same thing pi's own `/config` selector writes: an override pattern
`-<absolute path>` in the `extensions` array of the settings file that owns the
extension.

| extension lives in | written to |
|---|---|
| `~/.pi/agent/extensions/…` | `~/.pi/agent/settings.json` → `extensions` |
| `<project>/.pi/extensions/…` | `<project>/.pi/settings.json` → `extensions` |
| a package (`packages[]` in settings) | the same file → `packages[i].extensions` |

The project case is resolved by walking up from the failing path looking for the
`.pi` directory that owns it, not from pi's cwd: the startup hooks run before
`session_start`, when pi's real cwd is not known yet.

Nothing is moved, so pi's `/config` still shows the checkbox, and the guard
refuses to disable itself, anything in `ignore`, or an extension that belongs to
no settings file it recognises (it says so and changes nothing).

`state.json` is the guard's own record of what it disabled and why;
`guard.log` is the same thing as an append-only line log.

## Commands

```
/ext-guard                       status: mode, tmp free space, what is disabled
/ext-guard list                  only the disabled extensions, with cause and time
/ext-guard disable <name>        disable one by hand
/ext-guard enable <name>         undo it (removes the -path entry, loads next start)
/ext-guard forget <name>         drop the record, leave settings alone
/ext-guard log [n]               last n guard.log lines
/ext-guard on | off              arm / disarm for this session
```

`<name>` is matched against the path, the file name, the extension directory
name, or `dir/file.ts`; an ambiguous match lists the candidates instead of
guessing.

## Configuration

`config.json` next to this file, all optional:

| key | default | |
|---|---|---|
| `enabled` | `true` | master switch; off = pure passthrough, no wrappers installed |
| `interceptExit` | `true` | swallow the fatal `exit(1)` when only extension loads failed |
| `autoDisable` | `true` | write the disable entry without asking |
| `quarantineCrashes` | `true` | disable an extension that throws at runtime, when the stack names it |
| `notify` | `true` | report quarantines in the TUI at session start |
| `freeSpaceWarnBytes` | `1073741824` | below this much free space on the jiti cache filesystem, warn |
| `ignore` | `[]` | path fragments never auto-disabled |
| `logLimit` | `50` | records kept in `state.json` |

Every settings file the guard edits is backed up once, next to itself, as
`settings.json.ext-guard.bak`.

## The full-tmpfs mitigation

At load time the guard checks free space on `os.tmpdir()`. Below
`freeSpaceWarnBytes` it sets `JITI_FS_CACHE=0` for the rest of the process, so
extensions loaded *after* it transpile in memory instead of writing a cache
file. That rescues the extensions that come later in the load order; it does not
help the ones already loaded, and it does not replace freeing the disk. To make
it permanent, export `JITI_FS_CACHE=0` in your shell.

The guard itself is plain JS with `"type": "module"` in a `package.json` beside
it, on purpose: jiti then imports it natively, with no transform and no cache
write, so it still loads when the disk is full — which is the failure it exists
for. A TypeScript guard would fail exactly when it is needed.

## Known limits

- If **this** extension fails to load, nothing runs. It is deliberately the
  simplest thing in the directory, and `/ext-guard status` is how you check it.
- A load failure is only survivable when the exit really is the one pi printed
  for it. If pi also reported unrelated errors, printed something else in
  between, or exits for another reason later, the guard steps aside and lets pi
  exit — those need fixing anyway.
- A package extension whose package is no longer in `settings.json` cannot be
  disabled automatically; the guard says so instead of guessing.
- Runtime attribution uses the stack. A crash thrown from a worker, a detached
  process or a native module has no useful JavaScript frames, so it is treated
  as unattributable and pi exits as it would have.
- `settings.json` is rewritten by the guard while pi is running. The change takes
  effect on the next start; `/reload` is not needed and not used.
