/**
 * ext-guard — one broken extension must not take pi down with it.
 *
 * The problem
 * -----------
 * pi loads every extension, and if any one of them throws, `main.js` reports
 * the failure and calls `process.exit(1)`. One unparseable file, one missing
 * dependency, one full /tmp (jiti writes a transform cache to `os.tmpdir()`,
 * and a full tmpfs surfaces as `EDQUOT`) and the whole editor is gone — with the
 * hint "start without extensions using pi -ne", which also throws away the
 * extensions that were working.
 *
 * What this does
 * --------------
 * Two layers, both reversible, neither of which deletes or edits an extension:
 *
 *  1. Startup. `console.error` and `process.exit` are wrapped at load time.
 *     When pi reports `Failed to load extension "<path>": <err>` and then exits
 *     with 1 — and *only* when every error it reported is an extension load
 *     failure — the guard records the path, disables that extension, prints
 *     what it did, and lets the launch continue. The broken extension is
 *     already excluded from the loaded set (the loader discards it), so pi
 *     comes up with everything else working. The wrappers are removed the
 *     moment they are used, so no later exit in the session is affected.
 *
 *  2. Runtime. An `uncaughtException` / `unhandledRejection` whose stack points
 *     into a known extension file is attributed to that extension: it is
 *     disabled and the session continues. Anything that cannot be attributed to
 *     an extension is left to crash pi exactly as before.
 *
 * How "disabled" works
 * --------------------
 * The same thing pi's own `/config` selector writes: an override pattern
 * `-<absolute path>` in the `extensions` array of the settings file that owns
 * the extension (global `~/.pi/agent/settings.json`, the project's `.pi/
 * settings.json`, or a `packages[].extensions` filter for package-provided
 * extensions). The file is never moved, renamed or edited, `/config` still
 * shows the checkbox, and `/ext-guard enable <name>` puts it back.
 *
 * Commands: `/ext-guard [status|list|enable|disable|forget|log|on|off]`
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF_PATH = fileURLToPath(import.meta.url);
const CONFIG_PATH = path.join(HERE, "config.json");
const STATE_PATH = path.join(HERE, "state.json");
const LOG_PATH = path.join(HERE, "guard.log");
const TAG = "ext-guard";
const LOG_MAX_BYTES = 1_000_000;

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} Config
 * @property {boolean} enabled              Master switch. Off = pure passthrough, no wrappers installed.
 * @property {boolean} interceptExit        Swallow the fatal exit(1) when the only errors are extension load failures.
 * @property {boolean} autoDisable          Write the disable entry without asking.
 * @property {boolean} quarantineCrashes    Disable an extension that throws at runtime, when the stack names it.
 * @property {boolean} notify               Report quarantines in the TUI at session start.
 * @property {number}  freeSpaceWarnBytes    Below this much free space on the jiti cache filesystem, warn and try the cache-less load.
 * @property {string[]} ignore              Path fragments never disabled by the guard (yours and its own are always ignored).
 * @property {number}  logLimit             Lines kept in state.json's history.
 */

/** @type {Config} */
const DEFAULTS = {
	enabled: true,
	interceptExit: true,
	autoDisable: true,
	quarantineCrashes: true,
	notify: true,
	freeSpaceWarnBytes: 1024 * 1024 * 1024,
	ignore: [],
	logLimit: 50,
};

/** @type {Config} */
let config = { ...DEFAULTS };
let configDirty = false;

/** Live values, refreshed on session_start so the guard follows the real cwd. */
let ui = null;
let cwd = process.cwd();

/* ------------------------------------------------------------------ *
 * Tiny helpers
 * ------------------------------------------------------------------ */

const realConsoleError = console.error.bind(console);
const realExit = process.exit.bind(process);

function say(message) {
	// Always the real console.error: our own output must never be classified.
	realConsoleError(`${TAG}: ${message}`);
}

function readJson(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
}

function writeJsonAtomic(file, data) {
	const tmp = `${file}.${TAG}-${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
	fs.renameSync(tmp, file);
}

/** Never lose the user's settings: one backup, taken before the first edit. */
function backupOnce(file) {
	const bak = `${file}.${TAG}.bak`;
	try {
		if (fs.existsSync(file) && !fs.existsSync(bak)) fs.copyFileSync(file, bak);
	} catch {
		// a missing backup is not worth failing a launch over
	}
}

function appendLog(entry) {
	try {
		if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > LOG_MAX_BYTES) fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
		fs.appendFileSync(LOG_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
	} catch {
		// logging is best effort
	}
}

function agentDir() {
	const env = process.env.PI_CODING_AGENT_DIR?.trim();
	return env ? path.resolve(env) : path.join(os.homedir(), ".pi", "agent");
}

function globalSettingsPath() {
	return path.join(agentDir(), "settings.json");
}

function projectDir() {
	return path.join(cwd, ".pi");
}

function isUnder(child, parent) {
	const rel = path.relative(path.resolve(parent), path.resolve(child));
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function toPosix(p) {
	return p.split(path.sep).join("/");
}

function stripAnsi(s) {
	// eslint-disable-next-line no-control-regex
	return s.replace(/\u001b\[[0-9;]*m/g, "");
}

function oneLine(s, max = 200) {
	const t = String(s).replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function freeBytes(target) {
	try {
		const st = fs.statfsSync(target);
		return Number(st.bsize) * Number(st.bavail);
	} catch {
		return null;
	}
}

function formatBytes(n) {
	if (n === null) return "unknown";
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let value = n;
	let i = 0;
	while (value >= 1024 && i < units.length - 1) {
		value /= 1024;
		i++;
	}
	return `${value.toFixed(value < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

/* ------------------------------------------------------------------ *
 * State: what the guard disabled, and why
 * ------------------------------------------------------------------ */

/** @type {{disabled: Record<string, {path: string, at: string, kind: string, error: string, scope: string}>}} */
let state = { disabled: {} };

function loadState() {
	const raw = readJson(STATE_PATH, null);
	state = raw && typeof raw === "object" && raw.disabled && typeof raw.disabled === "object" ? { disabled: raw.disabled } : { disabled: {} };
}

function saveState() {
	const entries = Object.values(state.disabled).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, config.logLimit);
	try {
		writeJsonAtomic(STATE_PATH, { disabled: Object.fromEntries(entries.map((e) => [e.path, e])) });
	} catch {
		// best effort
	}
}

function remember(absPath, kind, error, scope) {
	state.disabled[absPath] = { path: absPath, at: new Date().toISOString(), kind, error: oneLine(error), scope };
	saveState();
	appendLog({ action: "disable", path: absPath, kind, error: oneLine(error), scope });
}

function forget(absPath) {
	if (state.disabled[absPath]) {
		delete state.disabled[absPath];
		saveState();
		appendLog({ action: "forget", path: absPath });
		return true;
	}
	return false;
}

/* ------------------------------------------------------------------ *
 * Which settings file owns an extension, and how to disable it there
 * ------------------------------------------------------------------ */

const OVERRIDE_KEY = "extensions";

/** The installed root of a configured package, best effort. */
function packageRoots(scope) {
	const file = scope === "project" ? path.join(projectDir(), "settings.json") : globalSettingsPath();
	const settings = readJson(file, {});
	const packages = Array.isArray(settings.packages) ? settings.packages : [];
	const roots = [];
	for (const pkg of packages) {
		const source = typeof pkg === "string" ? pkg : pkg?.source;
		if (typeof source !== "string") continue;
		const push = (root) => roots.push({ source, root, scope });
		if (source.startsWith("npm:")) {
			push(path.join(scope === "project" ? path.join(cwd, ".pi", "npm") : path.join(agentDir(), "npm"), "node_modules", source.slice(4)));
		} else if (source.startsWith("git:")) {
			const rest = source.slice(4);
			const at = rest.indexOf("@");
			const url = at > 0 ? rest.slice(0, at) : rest;
			push(path.join(scope === "project" ? path.join(cwd, ".pi", "git") : path.join(agentDir(), "git"), url.replace(/[:/]+/g, path.sep)));
		} else {
			const base = scope === "project" ? path.join(cwd, ".pi") : agentDir();
			push(path.resolve(base, source));
		}
	}
	return roots;
}

/**
 * The `.pi` directory that owns this extension, found by walking up from the
 * file itself. The startup hooks run before `session_start`, so pi's real cwd
 * is not known yet; the path pi prints is absolute and self-describing, so ask
 * the filesystem instead of guessing.
 */
function projectDirOwning(absPath) {
	let dir = path.dirname(absPath);
	for (;;) {
		const candidate = path.join(dir, ".pi");
		if (isUnder(absPath, path.join(candidate, "extensions"))) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** @returns {{file: string, scope: string, packageSource?: string} | null} */
function ownerOf(absPath) {
	// A project .pi that genuinely owns the path (it lives under its extensions/).
	const owning = projectDirOwning(absPath);
	if (owning) return { file: path.join(owning, "settings.json"), scope: "project" };
	// agentDir nests inside projectDir() whenever pi runs from the home dir --
	// ~/.pi/agent is under ~/.pi -- so this check has to come first. Testing
	// projectDir() ahead of it classified every personal extension as project
	// scope and disabled it through a ~/.pi/settings.json that does not exist.
	if (isUnder(absPath, agentDir())) return { file: globalSettingsPath(), scope: "user" };
	if (isUnder(absPath, projectDir())) return { file: path.join(projectDir(), "settings.json"), scope: "project" };
	// Longest package root wins, so a package inside another package still matches.
	// User scope breaks ties: from the home dir both root sets are the same paths,
	// and a stable sort would otherwise hand the project one every time.
	const candidates = [...packageRoots("project"), ...packageRoots("user")]
		.filter((p) => isUnder(absPath, p.root))
		.sort((a, b) => b.root.length - a.root.length || (a.scope === b.scope ? 0 : a.scope === "user" ? -1 : 1));
	const owner = candidates[0];
	if (owner) {
		return {
			file: owner.scope === "project" ? path.join(projectDir(), "settings.json") : globalSettingsPath(),
			scope: owner.scope,
			packageSource: owner.source,
		};
	}
	return null;
}

const isOverride = (entry) => typeof entry === "string" && entry.startsWith("-");
const stripOverride = (entry) => entry.replace(/^[-+!]/, "");
const isBareOrForced = (entry) => typeof entry === "string" && !/^[-+!]/.test(entry);
const pattern = (absPath) => `-${toPosix(absPath)}`;

/**
 * Disable an extension the way pi's own config selector does.
 * @returns {{ok: boolean, where: string, detail?: string}}
 */
function disableInSettings(absPath, owner) {
	const settings = readJson(owner.file, null);
	if (settings === null || typeof settings !== "object") return { ok: false, where: owner.file, detail: "settings file is not readable JSON" };

	if (owner.packageSource) {
		const packages = Array.isArray(settings.packages) ? settings.packages : [];
		const index = packages.findIndex((p) => (typeof p === "string" ? p : p?.source) === owner.packageSource);
		if (index < 0) return { ok: false, where: owner.file, detail: `package ${owner.packageSource} is no longer in settings` };
		const entry = typeof packages[index] === "string" ? { source: packages[index] } : { ...packages[index] };
		const list = Array.isArray(entry[OVERRIDE_KEY]) ? [...entry[OVERRIDE_KEY]] : [];
		const target = stripOverride(pattern(absPath));
		if (!list.some((p) => stripOverride(p) === target || p === target)) list.push(pattern(absPath));
		entry[OVERRIDE_KEY] = list;
		packages[index] = entry;
		settings.packages = packages;
	} else {
		const list = Array.isArray(settings[OVERRIDE_KEY]) ? [...settings[OVERRIDE_KEY]] : [];
		const target = stripOverride(pattern(absPath));
		// A plain or `+` entry for the same file would re-enable it; drop those.
		// `!path` entries are left alone: they mean the same thing here.
		const cleaned = list.filter((p) => !(isBareOrForced(p) && stripOverride(p) === target));
		if (!cleaned.some((p) => p === pattern(absPath))) cleaned.push(pattern(absPath));
		settings[OVERRIDE_KEY] = cleaned;
	}

	backupOnce(owner.file);
	try {
		writeJsonAtomic(owner.file, settings);
	} catch (err) {
		return { ok: false, where: owner.file, detail: err instanceof Error ? err.message : String(err) };
	}
	return { ok: true, where: owner.file };
}

/** @returns {{ok: boolean, where: string, detail?: string}} */
function enableInSettings(absPath, owner) {
	const settings = readJson(owner.file, null);
	if (settings === null || typeof settings !== "object") return { ok: false, where: owner.file, detail: "settings file is not readable JSON" };
	const target = stripOverride(pattern(absPath));
	let changed = false;

	if (owner.packageSource) {
		const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
		const index = packages.findIndex((p) => (typeof p === "string" ? p : p?.source) === owner.packageSource);
		if (index >= 0 && typeof packages[index] === "object" && Array.isArray(packages[index][OVERRIDE_KEY])) {
			const list = packages[index][OVERRIDE_KEY].filter((p) => stripOverride(p) !== target);
			changed = list.length !== packages[index][OVERRIDE_KEY].length;
			if (list.length) packages[index] = { ...packages[index], [OVERRIDE_KEY]: list };
			else {
				const { [OVERRIDE_KEY]: _drop, ...rest } = packages[index];
				packages[index] = Object.keys(rest).length ? rest : packages[index].source;
			}
			settings.packages = packages;
		}
	} else {
		const list = Array.isArray(settings[OVERRIDE_KEY]) ? [...settings[OVERRIDE_KEY]] : [];
		const kept = list.filter((p) => !(isOverride(p) && stripOverride(p) === target));
		changed = kept.length !== list.length;
		// An empty `extensions` array is not the same as no array at all in every
		// code path that reads settings; drop the key instead of leaving it empty.
		if (changed && kept.length === 0) delete settings[OVERRIDE_KEY];
		else if (changed) settings[OVERRIDE_KEY] = kept;
	}

	if (!changed) return { ok: true, where: owner.file, detail: "was not disabled" };
	backupOnce(owner.file);
	try {
		writeJsonAtomic(owner.file, settings);
	} catch (err) {
		return { ok: false, where: owner.file, detail: err instanceof Error ? err.message : String(err) };
	}
	return { ok: true, where: owner.file };
}

/* ------------------------------------------------------------------ *
 * Quarantine
 * ------------------------------------------------------------------ */

const SELF_DIR = HERE;

function isProtected(absPath) {
	if (path.resolve(absPath) === path.resolve(SELF_PATH)) return true;
	if (path.resolve(path.dirname(absPath)) === path.resolve(SELF_DIR)) return true;
	return config.ignore.some((frag) => frag && absPath.includes(frag));
}

const DISK_FULL = /EDQUOT|ENOSPC|EFBIG|no space left|disk quota/i;

/**
 * Disable one broken extension and report it.
 * @param {string} absPath
 * @param {"load" | "crash"} kind
 * @param {string} error
 */
function quarantine(absPath, kind, error) {
	if (isProtected(absPath)) {
		say(`NOT disabling ${absPath}: it is this guard (or on the ignore list). Fix it or set "ignore" in config.json.`);
		appendLog({ action: "skip-self", path: absPath, kind, error: oneLine(error) });
		return { ok: false, reason: "protected" };
	}
	const owner = ownerOf(absPath);
	if (!owner) {
		say(
			`could not disable ${absPath}: it belongs to no settings file this guard knows. ` +
				`Start with "pi -ne" or remove it with "pi package remove"; nothing was changed.`,
		);
		appendLog({ action: "no-owner", path: absPath, kind, error: oneLine(error) });
		return { ok: false, reason: "no-owner" };
	}
	if (!config.autoDisable) {
		say(`would disable ${absPath} (${oneLine(error, 80)}). Set "autoDisable": true, or run /ext-guard disable ${shortName(absPath)}.`);
		return { ok: false, reason: "autoDisable-off" };
	}
	return applyDisable(absPath, owner, kind, error);
}

/** The settings write itself, shared by the automatic and the manual path. */
function applyDisable(absPath, owner, kind, error) {
	const res = disableInSettings(absPath, owner);
	if (!res.ok) {
		say(`failed to disable ${absPath}: ${res.detail} (${res.where})`);
		appendLog({ action: "disable-failed", path: absPath, kind, error: oneLine(error), detail: res.detail });
		return { ok: false, reason: res.detail };
	}

	remember(absPath, kind, error, owner.packageSource ? `package ${owner.packageSource}` : owner.scope);
	say(
		`disabled ${absPath}\n` +
			`  cause   : ${oneLine(error, 160)}\n` +
			`  how     : ${res.where}${owner.packageSource ? ` (packages[${owner.packageSource}].extensions)` : ` (extensions: ["${pattern(absPath)}"])`}\n` +
			`  restore : /ext-guard enable ${shortName(absPath)}   (or pi's /config)`,
	);
	if (DISK_FULL.test(String(error))) {
		say(
			`the failure looks like a full filesystem, not a broken extension: jiti writes a transform cache to ` +
				`${os.tmpdir()} (${formatBytes(freeBytes(os.tmpdir()))} free). Free space, or run with JITI_FS_CACHE=0 pi.`,
		);
	}
	return { ok: true, owner, path: absPath };
}

function shortName(absPath) {
	const base = path.basename(absPath);
	const parent = path.basename(path.dirname(absPath));
	return parent && parent !== "extensions" ? `${parent}/${base}` : base;
}

/* ------------------------------------------------------------------ *
 * Layer 1 — startup: wrap console.error and process.exit
 * ------------------------------------------------------------------ */

/** @type {Map<string, string>} extension path -> reported error */
const loadFailures = new Map();
/** Fatal diagnostics that were *not* extension load failures. */
const otherFatals = [];
/**
 * Anything printed after a load failure that is not part of the same
 * diagnostic batch. pi prints the failures, then any warnings, then the yellow
 * `-ne` hint, then exits — all in one synchronous block. Anything else in
 * between means this exit is about something else, and swallowing it would be
 * continuing a session that is genuinely broken.
 */
let foreignOutput = false;
/** When the last load failure was printed. pi exits in the same tick as the report. */
let lastFailureAt = 0;
/** How long a reported failure may still explain an exit(1). */
const FAILURE_WINDOW_MS = 5000;
let exitWrapped = false;
let exitUsed = false;
/** Names disabled during this launch, reported once the session is up. */
let pendingNotice = [];

const LOAD_FAILURE = /^Error:\s*Failed to load extension "([^"]+)":\s*([\s\S]*)$/;
const FATAL_PREFIX = /^Error:\s+/;

function inspectDiagnostic(text) {
	const line = stripAnsi(text).trim();
	if (!line) return;
	const match = LOAD_FAILURE.exec(line);
	if (match) {
		loadFailures.set(path.resolve(cwd, match[1]), match[2].trim());
		lastFailureAt = Date.now();
		return;
	}
	if (FATAL_PREFIX.test(line)) {
		otherFatals.push(line);
		return;
	}
	// Warnings and pi's own hint belong to the same batch; anything else does not.
	if (loadFailures.size > 0 && !/^Warning:\s/.test(line) && !/^Hint:\s/.test(line)) foreignOutput = true;
}

function wrapConsole() {
	console.error = (...args) => {
		try {
			inspectDiagnostic(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
		} catch {
			// classification must never break logging
		}
		realConsoleError(...args);
	};
}

function unwrapExit() {
	if (exitWrapped) {
		exitWrapped = false;
		process.exit = realExit;
	}
}

/**
 * pi prints the diagnostics and then calls process.exit(1). Swallow that exit
 * only when the failures are exclusively extension load failures: any other
 * error means the session is genuinely broken and pi's own exit is the right
 * outcome.
 */
function wrappedExit(code) {
	if (exitUsed) return realExit(code);
	exitUsed = true;
	unwrapExit();

	const onlyExtensionFailures =
		loadFailures.size > 0 && otherFatals.length === 0 && !foreignOutput && Date.now() - lastFailureAt <= FAILURE_WINDOW_MS;
	if (!config.enabled || !config.interceptExit || code !== 1 || !onlyExtensionFailures) {
		if (loadFailures.size > 0 && (otherFatals.length > 0 || foreignOutput)) {
			say("extension load failures were reported alongside other output, so pi is exiting as usual. Fix those first, then retry.");
		} else if (loadFailures.size > 0) {
			say("a load failure was reported earlier, but this exit is not the one that followed it, so pi is exiting as usual.");
		}
		return realExit(code);
	}

	say(
		`${loadFailures.size} extension(s) failed to load. Disabling ${config.autoDisable ? "them" : "nothing (autoDisable is off)"} ` +
			"and starting pi without them instead of exiting.",
	);
	const done = [];
	for (const [absPath, error] of loadFailures) {
		const res = quarantine(absPath, "load", error);
		if (res.ok) done.push(shortName(absPath));
	}
	say(
		done.length
			? `starting without: ${done.join(", ")}. Everything else loaded normally.`
			: "nothing could be disabled automatically — see the messages above.",
	);
	// Return instead of exiting: pi continues into its normal startup path with
	// the broken extensions already absent from the loaded set.
	pendingNotice = done;
}

function installStartupHooks() {
	wrapConsole();
	// Deliberately not `process.exit`'s declared `never` return: this wrapper is
	// allowed to return, which is the entire point.
	process.exit = (code) => wrappedExit(typeof code === "number" ? code : 0);
	exitWrapped = true;
}

function removeStartupHooks() {
	unwrapExit();
	console.error = realConsoleError;
}

/* ------------------------------------------------------------------ *
 * Layer 2 — runtime: attribute a crash to an extension by its stack
 * ------------------------------------------------------------------ */

/** @type {Map<string, string[]>} root -> entry files, computed lazily */
const entryCache = new Map();

/** Extension entry points under `root`, mirroring pi's discovery rules. */
function discoverEntries(root, maxDepth) {
	const out = [];
	const walk = (dir, depth) => {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const p = path.join(dir, entry.name);
			if (entry.isFile() || entry.isSymbolicLink()) {
				if (/\.(ts|js|mjs|cjs)$/.test(entry.name)) out.push(p);
				continue;
			}
			if (depth >= maxDepth) continue;
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			// A package manifest wins, exactly as in pi's resolveExtensionEntries.
			const pkg = readJson(path.join(p, "package.json"), null);
			const manifest = pkg && typeof pkg === "object" && pkg.pi && typeof pkg.pi === "object" ? pkg.pi : null;
			if (manifest && Array.isArray(manifest.extensions) && manifest.extensions.length > 0) {
				for (const rel of manifest.extensions) {
					const abs = path.resolve(p, rel);
					if (fs.existsSync(abs)) out.push(abs);
				}
				continue;
			}
			const index = ["index.ts", "index.js"].map((n) => path.join(p, n)).find((c) => fs.existsSync(c));
			if (index) out.push(index);
			else walk(p, depth + 1);
		}
	};
	// depth counts directory levels below `root`: pi descends exactly one level
	// for a plain extensions dir (dir/index.ts), and no further without a manifest.
	walk(root, 0);
	return out;
}

function entriesFor(root, maxDepth = 1) {
	const hit = entryCache.get(root);
	if (hit) return hit;
	const found = discoverEntries(root, maxDepth);
	entryCache.set(root, found);
	return found;
}

/** The extension entry file a stack frame belongs to, or undefined. */
function entryForFrame(frame) {
	const roots = [
		{ root: path.join(agentDir(), "extensions"), depth: 1 },
		{ root: path.join(projectDir(), "extensions"), depth: 1 },
		...packageRoots("project").map((p) => ({ root: p.root, depth: 3 })),
		...packageRoots("user").map((p) => ({ root: p.root, depth: 3 })),
	];
	for (const { root, depth } of roots) {
		if (!isUnder(frame, root)) continue;
		// Longest matching entry wins: a helper the extension imported maps back
		// to the entry file pi actually loaded. No match means we cannot name the
		// extension, and a wrong name would disable the wrong thing.
		const hit = entriesFor(root, depth)
			.filter((entry) => frame === entry || frame.startsWith(`${entry}${path.sep}`))
			.sort((a, b) => b.length - a.length)[0];
		return hit;
	}
	return undefined;
}

function attribute(err) {
	const stack = String(err?.stack ?? err ?? "");
	if (!stack) return undefined;
	for (const line of stack.split("\n")) {
		const m = /((?:\/|[A-Za-z]:\\)[^\s():]+\.(?:ts|js|mjs|cjs))(?::\d+:\d+)?/.exec(line);
		if (!m) continue;
		const file = path.resolve(m[1]);
		const entry = entryForFrame(file);
		if (entry) return entry;
	}
	return undefined;
}

let quarantineHandlersInstalled = false;

function onFatal(kind, err) {
	const entry = attribute(err);
	const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
	if (!entry || !config.enabled || !config.quarantineCrashes) {
		// Not attributable to an extension: keep pi's own behaviour (print, exit 1)
		// instead of silently swallowing an unrelated crash.
		realConsoleError(`${TAG}: unhandled ${kind} not attributable to an extension, exiting as pi would: ${oneLine(message)}`);
		removeCrashHooks();
		realExit(1);
		return;
	}
	say(`unhandled ${kind} inside ${entry}: ${oneLine(message, 200)}`);
	quarantine(entry, "crash", message);
	say("the session continues without that extension. Fix it, then /ext-guard enable it.");
}

function onUncaught(err) {
	onFatal("exception", err);
}

function onUnhandled(reason) {
	onFatal("rejection", reason);
}

function installCrashHooks() {
	if (quarantineHandlersInstalled) return;
	quarantineHandlersInstalled = true;
	process.on("uncaughtException", onUncaught);
	process.on("unhandledRejection", onUnhandled);
}

function removeCrashHooks() {
	if (!quarantineHandlersInstalled) return;
	quarantineHandlersInstalled = false;
	process.removeListener("uncaughtException", onUncaught);
	process.removeListener("unhandledRejection", onUnhandled);
}

/* ------------------------------------------------------------------ *
 * Disk-full mitigation
 * ------------------------------------------------------------------ */

let diskChecked = false;

/**
 * jiti caches every transpiled extension under `os.tmpdir()/jiti` (or a
 * `node_modules/.cache/jiti` next to it). When that filesystem is full, the
 * write throws and *every* extension fails to load — including this one, if it
 * were TypeScript. Turning the fs cache off makes later loads transform in
 * memory instead, which is slower but survives a full tmpfs.
 */
function checkDisk() {
	if (diskChecked) return;
	diskChecked = true;
	const target = os.tmpdir();
	const free = freeBytes(target);
	if (free === null || free >= config.freeSpaceWarnBytes) return;
	say(`${target} has only ${formatBytes(free)} free; extension transform caches may fail to write.`);
	if (process.env.JITI_FS_CACHE === undefined || process.env.JITI_FS_CACHE === "true") {
		process.env.JITI_FS_CACHE = "0";
		say("set JITI_FS_CACHE=0 for this process: extensions loaded from here on transpile in memory instead of writing a cache.");
	}
}

/* ------------------------------------------------------------------ *
 * Session plumbing
 * ------------------------------------------------------------------ */

function loadConfig() {
	const raw = readJson(CONFIG_PATH, null);
	config = raw && typeof raw === "object" ? { ...DEFAULTS, ...raw } : { ...DEFAULTS };
	if (!fs.existsSync(CONFIG_PATH)) configDirty = true;
}

function saveConfig() {
	if (!configDirty) return;
	try {
		writeJsonAtomic(CONFIG_PATH, config);
		configDirty = false;
	} catch {
		// a read-only config must not break the guard
	}
}

function set(key, value) {
	config[key] = value;
	configDirty = true;
	saveConfig();
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

/** Resolve a user-supplied name or path fragment to known extensions. */
function resolveTargets(needle) {
	const q = needle.trim().toLowerCase();
	const known = [
		...entriesFor(path.join(agentDir(), "extensions"), 1),
		...entriesFor(path.join(projectDir(), "extensions"), 1),
		...Object.keys(state.disabled),
	];
	const hits = [...new Set(known)].filter((p) => {
		const base = path.basename(p).toLowerCase();
		const dir = path.basename(path.dirname(p)).toLowerCase();
		return p.toLowerCase().includes(q) || base === q || base.replace(/\.[^.]+$/, "") === q || dir === q || shortName(p).toLowerCase() === q;
	});
	return hits;
}

function disabledList() {
	return Object.values(state.disabled).sort((a, b) => (a.at < b.at ? 1 : -1));
}

function statusText() {
	const failures = [...loadFailures.entries()].map(([p, e]) => `  ! ${p}\n      ${oneLine(e, 140)}`);
	return [
		`${TAG}: ${config.enabled ? "ON" : "OFF"}`,
		`  startup    : ${config.interceptExit ? "intercept the fatal exit, keep the session" : "let pi exit as usual"}`,
		`  autoDisable: ${config.autoDisable}   runtime quarantine: ${config.quarantineCrashes}`,
		`  tmp        : ${os.tmpdir()} (${formatBytes(freeBytes(os.tmpdir()))} free, JITI_FS_CACHE=${process.env.JITI_FS_CACHE ?? "unset"})`,
		`  settings   : ${globalSettingsPath()}`,
		`  disabled   : ${disabledList().length ? "" : "none"}`,
		...disabledList().map((d) => `    ${shortName(d.path)}  (${d.kind}, ${d.at})\n      ${d.error}`),
		...(failures.length ? ["  failed this launch:", ...failures] : []),
	].join("\n");
}

/* ------------------------------------------------------------------ *
 * Extension entry point
 * ------------------------------------------------------------------ */

export default function extGuard(pi) {
	// Nothing below may throw: a throwing factory is the exact failure this
	// extension exists to contain, and it would be caught by our own logic.
	try {
		loadConfig();
		loadState();
		saveConfig();
		checkDisk();
		if (config.enabled) {
			installStartupHooks();
			if (config.quarantineCrashes) installCrashHooks();
		}
	} catch (err) {
		say(`failed to arm (${err instanceof Error ? err.message : String(err)}); running as a passthrough.`);
		return;
	}

	pi.on("session_start", (_event, ctx) => {
		ui = ctx.ui;
		cwd = ctx.cwd;
		entryCache.clear();
		try {
			loadState();
		} catch {
			// keep whatever we had
		}
		if (config.notify && pendingNotice.length > 0) {
			ctx.ui.notify(`${TAG}: started without ${pendingNotice.join(", ")} — /ext-guard enable <name> to restore`, "warning");
			pendingNotice = [];
		} else if (config.notify && disabledList().length > 0) {
			ctx.ui.notify(`${TAG}: ${disabledList().length} extension(s) disabled after load failures — /ext-guard status`, "warning");
		}
	});

	pi.registerCommand("ext-guard", {
		description: "Extension crash guard (status|list|enable|disable|forget|log|on|off)",
		handler: async (args, ctx) => {
			ui = ctx.ui;
			cwd = ctx.cwd;
			const [sub, ...rest] = args.trim().split(/\s+/);
			const arg = rest.join(" ");
			const out = (msg, level = "info") => ctx.ui.notify(msg, level);

			switch ((sub ?? "status").toLowerCase()) {
				case "status":
					out(statusText());
					return;
				case "list": {
					const list = disabledList();
					if (!list.length) return out(`${TAG}: nothing is disabled`);
					out(
						`${TAG}: ${list.length} disabled\n` +
							list.map((d) => `  ${shortName(d.path)}  [${d.kind}] ${d.at}\n    ${d.error}\n    scope: ${d.scope}`).join("\n"),
					);
					return;
				}
				case "enable": {
					if (!arg) return out('usage: /ext-guard enable <name>', "error");
					const hits = resolveTargets(arg);
					if (hits.length === 0) return out(`${TAG}: no extension matches "${arg}"`, "error");
					if (hits.length > 1) return out(`${TAG}: "${arg}" is ambiguous: ${hits.map(shortName).join(", ")}`, "error");
					const abs = hits[0];
					const owner = ownerOf(abs);
					if (!owner) return out(`${TAG}: ${abs} belongs to no settings file this guard knows; remove it with "pi package remove"`, "error");
					const res = enableInSettings(abs, owner);
					if (!res.ok) return out(`${TAG}: ${res.detail} (${res.where})`, "error");
					forget(abs);
					out(`${TAG}: ${shortName(abs)} is enabled again in ${res.where}. It loads on the next pi start.`);
					return;
				}
				case "disable": {
					if (!arg) return out('usage: /ext-guard disable <name>', "error");
					const hits = resolveTargets(arg);
					if (hits.length === 0) return out(`${TAG}: no extension matches "${arg}"`, "error");
					if (hits.length > 1) return out(`${TAG}: "${arg}" is ambiguous: ${hits.map(shortName).join(", ")}`, "error");
					const abs = hits[0];
					const owner = ownerOf(abs);
					if (!owner) return out(`${TAG}: ${abs} belongs to no settings file this guard knows`, "error");
					const res = applyDisable(abs, owner, "manual", "disabled by hand with /ext-guard disable");
					out(res.ok ? `${TAG}: ${shortName(abs)} disabled; it stays off until /ext-guard enable` : `${TAG}: could not disable it`, res.ok ? "info" : "warning");
					return;
				}
				case "forget": {
					if (!arg) return out('usage: /ext-guard forget <name>', "error");
					const hits = resolveTargets(arg);
					if (hits.length === 0) return out(`${TAG}: no extension matches "${arg}"`, "error");
					if (hits.length > 1) return out(`${TAG}: "${arg}" is ambiguous: ${hits.map(shortName).join(", ")}`, "error");
					out(forget(hits[0]) ? `${TAG}: record for ${shortName(hits[0])} dropped (settings untouched)` : `${TAG}: no record for ${shortName(hits[0])}`, "info");
					return;
				}
				case "log": {
					const n = Math.max(1, Number(arg) || 10);
					let lines = [];
					try {
						lines = fs.readFileSync(LOG_PATH, "utf8").trim().split("\n").filter(Boolean).slice(-n);
					} catch {
						return out(`${TAG}: no log yet at ${LOG_PATH}`);
					}
					for (const line of lines) {
						try {
							const e = JSON.parse(line);
							out(`${e.at}  ${e.action}  ${shortName(String(e.path ?? "-"))}${e.error ? `  — ${oneLine(e.error, 80)}` : ""}`);
						} catch {
							out(oneLine(line, 160));
						}
					}
					return;
				}
				case "on":
					set("enabled", true);
					try {
						installStartupHooks();
						if (config.quarantineCrashes) installCrashHooks();
					} catch {
						// arming late is best effort; a failure here is reported by the status line
					}
					out(`${TAG}: ON — a failing extension will be disabled, not fatal`);
					return;
				case "off":
					set("enabled", false);
					removeStartupHooks();
					removeCrashHooks();
					out(`${TAG}: OFF — this session runs unwrapped`);
					return;
				default:
					out("usage: /ext-guard [status|list|enable <name>|disable <name>|forget <name>|log [n]|on|off]");
					return;
			}
		},
	});
}
