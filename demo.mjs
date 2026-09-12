#!/usr/bin/env node
// 60-second demo: feed each guard the same JSON Claude Code sends it, once with the incident that MUST
// be refused and once with its legitimate twin that MUST pass. Run: `node demo.mjs`
//
// Three guards do not judge a Bash command: scope-guard needs a `.agent-scope` beside the file,
// ui-evidence-guard needs a git branch with a UI diff, goal-guard needs an armed goal. Each gets a
// throwaway fixture under a scratch dir (removed on exit) so the demo runs from a bare checkout.
// Every hook run writes its telemetry to a scratch log, tagged as test traffic, so a demo never
// inflates the live fire count that keeps a hook alive.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scratchDir } from "./hooks/_scratch-dir.mjs";

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), "hooks");
const TELEMETRY = scratchDir("demo-telemetry");
const ENV = { ...process.env, HOOK_CTX: "test", HOOK_FIRE_LOG: join(TELEMETRY, "fires.log") };
delete ENV.CLAUDE_HOOKS_QUIET;

/** Spawn a hook on an event. Returns { fired, reason } — "fired" is REFUSED (deny/block) or WARNED (a prompt). */
function run(hook, event, env = ENV, cwd = undefined) {
  const r = spawnSync(process.execPath, [join(HOOKS, `${hook}.mjs`)], {
    input: JSON.stringify(event), encoding: "utf8", env, cwd,
  });
  const stdout = (r.stdout ?? "").trim();
  const stderr = (r.stderr ?? "").trim();
  let out = {};
  try { out = stdout ? JSON.parse(stdout) : {}; } catch { out = {}; }
  const hso = out.hookSpecificOutput ?? {};
  if (hso.permissionDecision === "deny") return { fired: "REFUSED", reason: String(hso.permissionDecisionReason ?? "") };
  if (out.decision === "block") return { fired: "REFUSED", reason: String(out.reason ?? "") };
  // A prompt-only guard (root-cause) warns through additionalContext, or on stderr, and never blocks.
  const ctx = hso.additionalContext ?? out.additionalContext ?? (stderr || null);
  if (ctx != null) return { fired: "WARNED", reason: String(ctx).replace(/^\s*⚠\s*/, "") };
  return { fired: null, reason: "" };
}

const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

// A structurally valid RGBA PNG (the guard checks magic bytes, not just size): CRC-32 by hand, since
// zlib.crc32 only exists on Node ≥ 22.2 and the demo must run on Node 20.
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function realPng(w = 64, h = 64) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  let seed = 0x2545f491;
  for (let y = 0; y < h; y++)
    for (let x = 1; x < stride; x++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      raw[y * stride + x] = seed >>> 24;
    }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const cases = []; // { hook, label, run: () => ({fired, reason}), mustFire }
const pair = (hook, bad, good) => {
  cases.push({ hook, label: bad.label, go: bad.go, mustFire: true });
  cases.push({ hook, label: good.label, go: good.go, mustFire: false });
};
const cmd = (command, hook) => ({ label: JSON.stringify(command), go: () => run(hook, bash(command)) });

// ── Bash guards: the incident and its twin, as commands ──────────────────────────────────────────
pair("fence-guard", cmd("git push origin main", "fence-guard"), cmd("git push origin feature/x", "fence-guard"));
pair("fence-guard", cmd('sh -c "pulumi up --yes"', "fence-guard"), cmd("pulumi preview", "fence-guard"));
pair("runaway-guard", cmd("yes for sure", "runaway-guard"), cmd("yes | head -3", "runaway-guard"));
pair("prose-guard", cmd("please run the tests again", "prose-guard"), cmd("npm test", "prose-guard"));
pair("piped-verdict-guard", cmd("git push origin main 2>&1 | tail -2", "piped-verdict-guard"), cmd("git push origin main", "piped-verdict-guard"));
pair("piped-verdict-guard", cmd("git merge --no-ff topic 2>&1 | tail -3", "piped-verdict-guard"), cmd("npm test 2>&1 | tail -5", "piped-verdict-guard"));
pair(
  "root-cause-guard",
  cmd('git commit -m "fix: TypeError: x is not a function"', "root-cause-guard"),
  cmd('git commit -m "fix: TypeError: x, see chunk.js:1:15825"', "root-cause-guard"),
);

// ── scope-guard: an Edit outside the paths the task declared ─────────────────────────────────────
{
  const lane = scratchDir("demo-scope");
  writeFileSync(join(lane, ".agent-scope"), JSON.stringify({ allow: ["packages/db/**"], reason: "slice B" }));
  const edit = (rel) => ({ tool_name: "Edit", tool_input: { file_path: join(lane, ...rel.split("/")) }, cwd: lane });
  pair(
    "scope-guard",
    { label: "Edit apps/web/auth.ts   (scope: packages/db/**)", go: () => run("scope-guard", edit("apps/web/auth.ts")) },
    { label: "Edit packages/db/m.sql  (scope: packages/db/**)", go: () => run("scope-guard", edit("packages/db/m.sql")) },
  );
}

// ── ui-evidence-guard: "done" on a branch that changed a screen, with and without a screenshot ───
{
  const repo = scratchDir("demo-uieg");
  const genv = {
    ...ENV, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(repo, "no-global-gitconfig"),
    GIT_AUTHOR_NAME: "demo", GIT_AUTHOR_EMAIL: "demo@example", GIT_COMMITTER_NAME: "demo", GIT_COMMITTER_EMAIL: "demo@example",
  };
  const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", env: genv }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, ".gitignore"), ".evidence/\n");
  git("add", "-A"); git("commit", "-q", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "-q", "-b", "feat/panel");
  mkdirSync(join(repo, "apps", "web", "app"), { recursive: true });
  writeFileSync(join(repo, "apps", "web", "app", "page.tsx"), 'export default () => <div className="new" />;\n');
  git("add", "-A"); git("commit", "-q", "-m", "ui change");
  const stop = { hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "The panel is done and verified." };
  pair(
    "ui-evidence-guard",
    { label: '"done and verified"  UI diff, .evidence/ empty', go: () => run("ui-evidence-guard", stop, genv, repo) },
    {
      label: '"done and verified"  UI diff, .evidence/ has a shot',
      go: () => {
        mkdirSync(join(repo, ".evidence", "panel"), { recursive: true });
        writeFileSync(join(repo, ".evidence", "panel", "shot.png"), realPng()); // a real PNG, > 5 KB, magic bytes intact
        return run("ui-evidence-guard", stop, genv, repo);
      },
    },
  );
}

// ── goal-guard: a completion claim before and after the stopping command ran green ───────────────
// The scratch dir is the session's cwd: a stopping command must live inside the worktree it proves,
// so the proof script sits there and every call — arm, prove, Stop — is keyed to that directory.
{
  const state = scratchDir("demo-goal");
  const genv = { ...ENV, HOOK_STATE_DIR: state };
  const goal = (...args) => {
    const r = spawnSync(process.execPath, [join(HOOKS, "goal-guard.mjs"), ...args], { cwd: state, encoding: "utf8", env: genv });
    if (r.status !== 0) throw new Error(`goal-guard ${args[0]} failed:\n${r.stdout}${r.stderr}`);
  };
  const proof = join(state, "exit0.mjs");
  writeFileSync(proof, "process.exit(0)\n");
  goal("--set", "the flaky suite passes", "--done", `node ${proof}`);
  const stop = { hook_event_name: "Stop", stop_hook_active: false, cwd: state, last_assistant_message: "result: the suite is green and the goal is met." };
  pair(
    "goal-guard",
    { label: '"result: …"  goal armed, --prove never run', go: () => run("goal-guard", stop, genv, state) },
    { label: '"result: …"  after --prove recorded exit 0', go: () => { goal("--prove"); return run("goal-guard", stop, genv, state); } },
  );
}

let failures = 0;
let last = null;
for (const c of cases) {
  const r = c.go();
  const ok = c.mustFire ? r.fired !== null : r.fired === null;
  if (!ok) failures++;
  if (c.hook !== last) console.log(`\n${c.hook}`);
  last = c.hook;
  console.log(`  ${ok ? "✔" : "✘"} ${c.mustFire ? "must-fire     " : "must-not-fire "} ${c.label.padEnd(44)} → ${r.fired ?? "allowed"}`);
  if (r.reason) console.log(`      reason: ${r.reason.split("\n")[0].slice(0, 110)}`);
}
console.log(failures ? `\n${failures} case(s) misbehaved` : "\nEvery guard fired where it must and stayed silent where it must not.");
process.exit(failures ? 1 : 0);
