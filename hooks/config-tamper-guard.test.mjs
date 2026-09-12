// Behavioural test for config-tamper-guard.mjs — run: `node hooks/config-tamper-guard.test.mjs`.
//
// CONTRACT: a WRITE to the agent's control surface (.claude/settings*.json, .claude/hooks/,
// .agent-scope, .mcp.json, ~/.claude.json, git hooks / core.hooksPath, .git/config, the managed
// settings directory, `claude config|mcp|--settings`) is DENIED with a reason that names the path
// class and carries the fix. A READ of the same path, an INVOCATION of a hook, a write to
// .claude/skills|commands|agents, and a write to hooks/ at a repo root are ALLOWED. SessionStart never
// blocks and prints a content fingerprint. CONFIG_GUARD_ALLOW=1 in the HOOK's environment exempts
// (recorded); the same prefix inside the command does not.
//
// Every rule ships as a PAIR: the must-fire and its legitimate twin. Spawns the hook exactly as Claude
// Code does (event JSON on stdin), reads the decision from stdout, exits non-zero on the first miss.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPath, decideBash, lex, MAX_EVENT_BYTES } from "./config-tamper-guard.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "config-tamper-guard.mjs");

// A throwaway tree: <tree>/repo is the session cwd, with a real .claude/hooks and a symlink into it.
const TREE = mkdtempSync(join(tmpdir(), "config-tamper-guard-"));
const REPO = join(TREE, "repo");
mkdirSync(join(REPO, ".claude", "hooks"), { recursive: true });
mkdirSync(join(REPO, ".claude", "skills", "x"), { recursive: true });
mkdirSync(join(REPO, "notes"), { recursive: true });
mkdirSync(join(REPO, "hooks"), { recursive: true });
writeFileSync(join(REPO, ".claude", "hooks", "goal-guard.mjs"), "// a hook\n");
writeFileSync(join(REPO, ".claude", "settings.json"), '{"hooks":{}}\n');
let symlinks = true;
try {
  symlinkSync(join(REPO, ".claude", "hooks"), join(REPO, "link-to-hooks"), "dir");
  symlinkSync(join(REPO, ".claude"), join(TREE, "dot-claude-alias"), "dir");
} catch {
  symlinks = false; // Windows without developer mode: the symlink cases are skipped, not faked
}
process.on("exit", () => rmSync(TREE, { recursive: true, force: true }));

const BASE_ENV = (() => {
  const e = { ...process.env, HOOK_CTX: "test" };
  delete e.CLAUDE_HOOKS_QUIET;
  delete e.CONFIG_GUARD_ALLOW;
  e.HOOK_FIRE_LOG = join(TREE, "fires.log");
  return e;
})();

function run(event, env = BASE_ENV) {
  return spawnSync(process.execPath, [HOOK], {
    input: typeof event === "string" ? event : JSON.stringify({ cwd: REPO, ...event }),
    encoding: "utf8",
    env,
    timeout: 20000,
  });
}
function verdict(r) {
  if (r.signal) return "KILLED";
  if (r.status !== 0) return `EXIT_${r.status}`;
  const out = (r.stdout ?? "").trim();
  if (!out) return "allow";
  try {
    return JSON.parse(out).hookSpecificOutput.permissionDecision;
  } catch {
    return `UNPARSEABLE:${out.slice(0, 40)}`;
  }
}
const bash = (command, env) => verdict(run({ tool_name: "Bash", tool_input: { command } }, env));
const edit = (file_path, tool = "Write", env) =>
  verdict(run({ tool_name: tool, tool_input: { file_path, content: "x" } }, env));
const reasonOf = (event) => {
  try {
    return JSON.parse(run(event).stdout).hookSpecificOutput.permissionDecisionReason;
  } catch {
    return "";
  }
};

let fails = 0;
let pairs = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${label} → want ${want}, got ${got}`);
};
const FIRE = (label, got) => check(`FIRE  ${label}`, got, "deny");
const ALLOW = (label, got) => check(`ALLOW ${label}`, got, "allow");
/** A rule is a PAIR: the incident and its twin. Counted so the suite can assert its own breadth. */
const PAIR = (fireLabel, fireGot, allowLabel, allowGot) => {
  pairs++;
  FIRE(fireLabel, fireGot);
  ALLOW(allowLabel, allowGot);
};

// ── EDIT TOOLS: settings ────────────────────────────────────────────────────────────────────────────
PAIR("★ Write .claude/settings.json", edit(".claude/settings.json"),
     "Write .claude/skills/x/SKILL.md (a prompt, not control)", edit(".claude/skills/x/SKILL.md"));
PAIR("Edit .claude/settings.local.json", edit(".claude/settings.local.json", "Edit"),
     "Edit .claude/commands/x.md", edit(".claude/commands/x.md", "Edit"));
PAIR("MultiEdit absolute <repo>/.claude/settings.json", edit(join(REPO, ".claude", "settings.json"), "MultiEdit"),
     "MultiEdit .claude/agents/x.md", edit(".claude/agents/x.md", "MultiEdit"));
PAIR("Write ~/.claude/settings.json", edit("~/.claude/settings.json"),
     "Write ~/.claude/CLAUDE.md (memory, not control)", edit("~/.claude/CLAUDE.md"));
PAIR("Write $HOME/.claude/settings.json", edit("$HOME/.claude/settings.json"),
     "Write $HOME/notes.md", edit("$HOME/notes.md"));
PAIR("Write settings.json of a PARENT project via ..", edit("../repo/.claude/settings.json"),
     "Write ../repo/README.md", edit("../repo/README.md"));
PAIR("Write .claude/settings.json with a ./ prefix", edit("./.claude/settings.json"),
     "Write .claude/settings.json.example (a template)", edit(".claude/settings.json.example"));
PAIR("Read tool is not judged but Write of a hook is", edit(".claude/hooks/x.mjs"),
     "Read .claude/settings.json (tool_name Read)", edit(".claude/settings.json", "Read"));

// ── EDIT TOOLS: hooks dir, scope, mcp, git, managed, global ────────────────────────────────────────
PAIR("★ Write .claude/hooks/goal-guard.mjs", edit(".claude/hooks/goal-guard.mjs"),
     "Write hooks/goal-guard.mjs at the repo ROOT (a repo that develops hooks)", edit("hooks/goal-guard.mjs"));
PAIR("Write .claude/hooks/new-guard.mjs (not yet existing)", edit(".claude/hooks/new-guard.mjs"),
     "Write .claude/hooks-notes.md (not the hooks dir)", edit(".claude/hooks-notes.md"));
PAIR("NotebookEdit under .claude/hooks/", verdict(run({ tool_name: "NotebookEdit", tool_input: { notebook_path: ".claude/hooks/x.ipynb" } })),
     "NotebookEdit notes/x.ipynb", verdict(run({ tool_name: "NotebookEdit", tool_input: { notebook_path: "notes/x.ipynb" } })));
PAIR("Write .agent-scope", edit(".agent-scope"),
     "Write .agent-scope.md (docs about it)", edit(".agent-scope.md"));
PAIR("Write packages/x/.agent-scope (any directory)", edit("packages/x/.agent-scope"),
     "Write packages/x/scope.json", edit("packages/x/scope.json"));
PAIR("Write .mcp.json", edit(".mcp.json"),
     "Write mcp.json (no dot: an app's own file)", edit("mcp.json"));
PAIR("Write .git/hooks/pre-commit", edit(".git/hooks/pre-commit"),
     "Write .github/workflows/ci.yml", edit(".github/workflows/ci.yml"));
PAIR("Write .githooks/pre-push", edit(".githooks/pre-push"),
     "Write docs/git-hooks.md", edit("docs/git-hooks.md"));
PAIR("Write .git/config", edit(".git/config"),
     "Write .gitconfig-notes", edit(".gitconfig-notes"));
PAIR("Write ~/.claude.json (global config)", edit("~/.claude.json"),
     "Write ./.claude.json in the repo (not the global one)", edit("notes/.claude.json"));
PAIR("Write /etc/claude-code/managed-settings.json", edit("/etc/claude-code/managed-settings.json"),
     "Write /etc/hosts-notes.md is not our surface", edit("/etc/hosts-notes.md"));
PAIR("Write /etc/claude-code/managed-settings.d/team.json", edit("/etc/claude-code/managed-settings.d/team.json"),
     "Write docs/managed-settings.md", edit("docs/managed-settings.md"));
PAIR("Write /Library/Application Support/ClaudeCode/managed-mcp.json", edit("/Library/Application Support/ClaudeCode/managed-mcp.json"),
     "Write /Library/Application Support/OtherApp/x.json", edit("/Library/Application Support/OtherApp/x.json"));

// ── WINDOWS-SHAPED PATHS, judged on string shape on every platform ─────────────────────────────────
PAIR("Write C:\\x\\.claude\\settings.json", edit("C:\\x\\.claude\\settings.json"),
     "Write C:\\x\\.claude\\skills\\y\\SKILL.md", edit("C:\\x\\.claude\\skills\\y\\SKILL.md"));
PAIR("Write C:\\Users\\me\\.claude\\hooks\\g.mjs", edit("C:\\Users\\me\\.claude\\hooks\\g.mjs"),
     "Write C:\\Users\\me\\hooks\\g.mjs", edit("C:\\Users\\me\\hooks\\g.mjs"));
PAIR("Write C:\\Program Files\\ClaudeCode\\managed-settings.json", edit("C:\\Program Files\\ClaudeCode\\managed-settings.json"),
     "Write C:\\Program Files\\Other\\settings.json", edit("C:\\Program Files\\Other\\settings.json"));
PAIR("Write C:\\ProgramData\\ClaudeCode\\managed-settings.json (legacy path)", edit("C:\\ProgramData\\ClaudeCode\\managed-settings.json"),
     "Write C:\\ProgramData\\Other\\managed-settings.json", edit("C:\\ProgramData\\Other\\managed-settings.json"));
PAIR("Write C:\\x\\.GIT\\hooks\\pre-commit (case-folded)", edit("C:\\x\\.GIT\\hooks\\pre-commit"),
     "Write C:\\x\\src\\hooks\\useThing.ts", edit("C:\\x\\src\\hooks\\useThing.ts"));
PAIR("Write \\\\server\\share\\.claude\\settings.local.json (UNC)", edit("\\\\server\\share\\.claude\\settings.local.json"),
     "Write \\\\server\\share\\README.md", edit("\\\\server\\share\\README.md"));

// ── SYMLINKS: resolved through the deepest existing ancestor ───────────────────────────────────────
if (symlinks) {
  PAIR("Write link-to-hooks/x.mjs (symlink INTO .claude/hooks)", edit("link-to-hooks/x.mjs"),
       "Write notes/x.mjs (a plain directory)", edit("notes/x.mjs"));
  PAIR("Write <tree>/dot-claude-alias/settings.json (symlinked .claude)", edit(join(TREE, "dot-claude-alias", "settings.json")),
       "Write <tree>/other/settings.json", edit(join(TREE, "other", "settings.json")));
} else {
  console.log("skip  symlink cases: this filesystem refused symlinkSync");
}

// ── BASH: redirections ─────────────────────────────────────────────────────────────────────────────
PAIR("★ echo '{}' > .claude/settings.json", bash("echo '{}' > .claude/settings.json"),
     "cat .claude/settings.json", bash("cat .claude/settings.json"));
PAIR("echo x >> .claude/settings.local.json", bash("echo x >> .claude/settings.local.json"),
     "echo hi > notes/.claude-ideas.md", bash("echo hi > notes/.claude-ideas.md"));
PAIR("cat >.claude/hooks/x.mjs (attached)", bash("cat >.claude/hooks/x.mjs"),
     "cat .claude/hooks/x.mjs > /tmp/copy.mjs (a read)", bash("cat .claude/hooks/x.mjs > /tmp/copy.mjs"));
PAIR("cat > .claude/settings.json <<EOF … EOF", bash("cat > .claude/settings.json <<EOF\n{}\nEOF"),
     "heredoc BODY mentioning the shape is data", bash("cat > docs/notes.md <<'EOF'\necho x > .claude/settings.json\nEOF"));
PAIR("printf … >| .agent-scope (clobber)", bash("printf x >| .agent-scope"),
     "node x.mjs 2>/dev/null (fd redirect to a device)", bash("node x.mjs 2>/dev/null"));
PAIR("cmd &> .mcp.json", bash("cmd &> .mcp.json"),
     "cmd > out.log 2>&1 (fd dup)", bash("cmd > out.log 2>&1"));
PAIR("true && echo x > .git/hooks/pre-commit (second statement)", bash("true && echo x > .git/hooks/pre-commit"),
     "ls .git/hooks", bash("ls .git/hooks"));
PAIR('echo x >".claude/settings.json" (quoted target)', bash('echo x >".claude/settings.json"'),
     'echo ">.claude/settings.json" (quoted operator is data)', bash('echo ">.claude/settings.json"'));
PAIR("$(echo x > .claude/settings.json) inside a substitution", bash('echo "$(echo x > .claude/settings.json)"'),
     "git diff .claude/", bash("git diff .claude/"));
PAIR("echo x > ~/.claude/settings.json", bash("echo x > ~/.claude/settings.json"),
     "echo x > ~/.claude/CLAUDE.md", bash("echo x > ~/.claude/CLAUDE.md"));
PAIR("echo x > $X/.claude/settings.json (unexpanded var, shape)", bash("echo x > $X/.claude/settings.json"),
     "echo x > $X/settings.json", bash("echo x > $X/settings.json"));
PAIR("echo x > \"$HOME/.claude.json\"", bash('echo x > "$HOME/.claude.json"'),
     "echo x > \"$HOME/.claude/projects/notes.md\"", bash('echo x > "$HOME/.claude/projects/notes.md"'));

// ── BASH: tee / sed -i / perl -i ───────────────────────────────────────────────────────────────────
PAIR("echo x | tee .claude/settings.json", bash("echo x | tee .claude/settings.json"),
     "echo x | tee notes/out.txt", bash("echo x | tee notes/out.txt"));
PAIR("tee -a .agent-scope", bash("cat scope.json | tee -a .agent-scope"),
     "tee -a build.log", bash("cat scope.json | tee -a build.log"));
PAIR("★ sed -i 's/goal-guard/goal-guard.off/' .claude/settings.json", bash("sed -i 's/goal-guard/goal-guard.off/' .claude/settings.json"),
     "sed -n 's/x/y/p' .claude/settings.json (no -i: a read)", bash("sed -n 's/x/y/p' .claude/settings.json"));
PAIR("sed -i.bak -e 's/a/b/' .claude/hooks/x.mjs", bash("sed -i.bak -e 's/a/b/' .claude/hooks/x.mjs"),
     "sed -i 's/a/b/' src/app.ts", bash("sed -i 's/a/b/' src/app.ts"));
PAIR("sed --in-place 's/a/b/' .mcp.json", bash("sed --in-place 's/a/b/' .mcp.json"),
     "sed 's/a/b/' .mcp.json > /tmp/x", bash("sed 's/a/b/' .mcp.json > /tmp/x"));
PAIR("perl -pi -e 's/a/b/' .git/config", bash("perl -pi -e 's/a/b/' .git/config"),
     "perl -ne 'print' .git/config", bash("perl -ne 'print' .git/config"));

// ── BASH: cp / mv / ln / rm / chmod / others ───────────────────────────────────────────────────────
PAIR("cp /tmp/x.json .claude/settings.json (destination)", bash("cp /tmp/x.json .claude/settings.json"),
     "cp .claude/settings.json /tmp/backup.json (source: a read)", bash("cp .claude/settings.json /tmp/backup.json"));
PAIR("cp -t .claude/hooks /tmp/x.mjs", bash("cp -t .claude/hooks /tmp/x.mjs"),
     "cp -t /tmp/out .claude/hooks/x.mjs", bash("cp -t /tmp/out .claude/hooks/x.mjs"));
PAIR("mv .claude/hooks/goal-guard.mjs /tmp/ (source removed)", bash("mv .claude/hooks/goal-guard.mjs /tmp/"),
     "mv /tmp/a.mjs /tmp/b.mjs", bash("mv /tmp/a.mjs /tmp/b.mjs"));
PAIR("mv /tmp/x.json .claude/settings.local.json", bash("mv /tmp/x.json .claude/settings.local.json"),
     "mv notes/a.md notes/b.md", bash("mv notes/a.md notes/b.md"));
PAIR("ln -sf /tmp/evil .claude/settings.json", bash("ln -sf /tmp/evil .claude/settings.json"),
     "ln -s .claude/settings.json /tmp/peek.json (link elsewhere)", bash("ln -s .claude/settings.json /tmp/peek.json"));
PAIR("rm .claude/hooks/goal-guard.mjs", bash("rm .claude/hooks/goal-guard.mjs"),
     "rm -rf node_modules", bash("rm -rf node_modules"));
PAIR("rm -rf .claude/hooks (the directory)", bash("rm -rf .claude/hooks"),
     "rm -rf .claude/skills/old", bash("rm -rf .claude/skills/old"));
PAIR("rm .agent-scope", bash("rm .agent-scope"),
     "rm .agent-scope.bak", bash("rm .agent-scope.bak"));
PAIR("chmod -x .claude/hooks/goal-guard.mjs", bash("chmod -x .claude/hooks/goal-guard.mjs"),
     "chmod +x hooks/goal-guard.mjs (repo root)", bash("chmod +x hooks/goal-guard.mjs"));
PAIR("chmod 000 .git/hooks/pre-commit", bash("chmod 000 .git/hooks/pre-commit"),
     "chmod +x scripts/run.sh", bash("chmod +x scripts/run.sh"));
PAIR("truncate -s 0 .claude/settings.json", bash("truncate -s 0 .claude/settings.json"),
     "truncate -s 0 build.log", bash("truncate -s 0 build.log"));
PAIR("touch .claude/hooks/x.mjs", bash("touch .claude/hooks/x.mjs"),
     "touch notes/x.md", bash("touch notes/x.md"));
PAIR("dd if=/tmp/x of=.mcp.json", bash("dd if=/tmp/x of=.mcp.json"),
     "dd if=.mcp.json of=/tmp/x", bash("dd if=.mcp.json of=/tmp/x"));
PAIR("rsync /tmp/x/ .claude/hooks/", bash("rsync -a /tmp/x/ .claude/hooks/"),
     "rsync -a .claude/hooks/ /tmp/x/", bash("rsync -a .claude/hooks/ /tmp/x/"));
PAIR("install -m 755 x.mjs .claude/hooks/x.mjs", bash("install -m 755 x.mjs .claude/hooks/x.mjs"),
     "install -m 755 x.sh /usr/local/bin/x", bash("install -m 755 x.sh /usr/local/bin/x"));

// ── BASH: git config / claude CLI ──────────────────────────────────────────────────────────────────
PAIR("git config core.hooksPath /tmp/nohooks", bash("git config core.hooksPath /tmp/nohooks"),
     "git config user.name Bram", bash("git config user.name Bram"));
PAIR("git config --global core.hookspath x (any case)", bash("git config --global core.hookspath x"),
     "git config --get core.hooksPath (a read)", bash("git config --get core.hooksPath"));
PAIR("git config --unset core.hooksPath", bash("git config --unset core.hooksPath"),
     "git config --list", bash("git config --list"));
PAIR("git config --unset-all user.email", bash("git config --unset-all user.email"),
     "git config user.email x@y", bash("git config user.email x@y"));
PAIR("git config --remove-section remote.origin", bash("git config --remove-section remote.origin"),
     "git remote -v", bash("git remote -v"));
PAIR("claude config set hooks …", bash("claude config set hooks '{}'"),
     "claude config get theme", bash("claude config get theme"));
PAIR("claude config remove allowedTools x", bash("claude config remove allowedTools x"),
     "claude config list", bash("claude config list"));
PAIR("claude mcp add evil -- node x.js", bash("claude mcp add evil -- node x.js"),
     "claude mcp list", bash("claude mcp list"));
PAIR("claude --settings '{\"hooks\":{}}' -p x", bash("claude --settings '{\"hooks\":{}}' -p x"),
     "claude -p 'summarise'", bash("claude -p 'summarise'"));

// ── BASH: hook INVOCATION is not a write; wrappers cannot hide a write ─────────────────────────────
PAIR("sudo tee .claude/settings.json", bash("echo x | sudo tee .claude/settings.json"),
     "node .claude/hooks/goal-guard.mjs --set 'ship' --done 'npm test'", bash("node .claude/hooks/goal-guard.mjs --set 'ship' --done 'npm test'"));
PAIR("sh -c 'echo x > .claude/settings.json'", bash("sh -c 'echo x > .claude/settings.json'"),
     "sh -c 'cat .claude/settings.json'", bash("sh -c 'cat .claude/settings.json'"));
PAIR("bash -lc \"sed -i s/a/b/ .mcp.json\"", bash('bash -lc "sed -i s/a/b/ .mcp.json"'),
     "bash -lc \"grep hooks .mcp.json\"", bash('bash -lc "grep hooks .mcp.json"'));
PAIR("eval 'rm .agent-scope'", bash("eval 'rm .agent-scope'"),
     "eval 'cat .agent-scope'", bash("eval 'cat .agent-scope'"));
PAIR("env FOO=1 cp x .claude/hooks/y", bash("env FOO=1 cp x .claude/hooks/y"),
     "env | grep CLAUDE", bash("env | grep CLAUDE"));
PAIR("`echo x > .claude/settings.json` in backticks", bash("echo `echo x > .claude/settings.json`"),
     "git log --grep='.claude/settings.json'", bash("git log --grep='.claude/settings.json'"));
PAIR("a comment does not hide the next line", bash("# harmless\necho x > .claude/settings.json"),
     "a comment mentioning the write is data", bash("# echo x > .claude/settings.json\nls"));
PAIR("multi-line: second line writes", bash("ls\nprintf x > .git/config"),
     "multi-line: reads only", bash("ls\ncat .git/config"));

// ── THE HATCH: hook env exempts (recorded); the in-command prefix does not ─────────────────────────
{
  const IN_CMD = "CONFIG_GUARD_ALLOW=1 sed -i 's/a/b/' .claude/settings.json";
  PAIR("★ CONFIG_GUARD_ALLOW=1 as a COMMAND prefix does not count", bash(IN_CMD),
       "CONFIG_GUARD_ALLOW=1 in the HOOK's environment stands the guard down", bash(IN_CMD, { ...BASE_ENV, CONFIG_GUARD_ALLOW: "1" }));
  FIRE("env CONFIG_GUARD_ALLOW=1 sed -i … does not count either", bash("env CONFIG_GUARD_ALLOW=1 sed -i 's/a/b/' .claude/settings.json"));
  FIRE("CLAUDE_HOOKS_QUIET=1 does NOT lift this guard", bash("rm .agent-scope", { ...BASE_ENV, CLAUDE_HOOKS_QUIET: "1" }));
  FIRE("CONFIG_GUARD_ALLOW=0 is not the hatch", bash("rm .agent-scope", { ...BASE_ENV, CONFIG_GUARD_ALLOW: "0" }));
  const log = readFileSync(BASE_ENV.HOOK_FIRE_LOG, "utf8").split("\n").filter(Boolean);
  check("the env exemption is recorded as a fire of kind exempted", log.some((l) => /\tconfig-tamper-guard\.mjs\tallow\texempted\t/.test(l)), true);
  check("a deny is recorded with its path class as kind", log.some((l) => /\tconfig-tamper-guard\.mjs\tdeny\tsettings\t/.test(l)), true);
  ALLOW("the hatch also exempts the edit tools", edit(".claude/settings.json", "Write", { ...BASE_ENV, CONFIG_GUARD_ALLOW: "1" }));
}

// ── THE REASON: names the class and carries the fix ────────────────────────────────────────────────
{
  const r = reasonOf({ tool_name: "Bash", tool_input: { command: "sed -i 's/a/b/' .claude/settings.json" } });
  check("reason names the settings class", /settings file/.test(r), true);
  check("reason names the path", /\.claude\/settings\.json/.test(r), true);
  check("reason carries the fix (own terminal, or CONFIG_GUARD_ALLOW=1)", /own terminal.*CONFIG_GUARD_ALLOW=1/.test(r), true);
  check("reason says the in-command prefix does not count", /prefix inside a Bash command does not count/.test(r), true);
  check("hooks-dir reason names the hooks class", /\.claude\/hooks\//.test(reasonOf({ tool_name: "Write", tool_input: { file_path: ".claude/hooks/x.mjs" } })), true);
  check("git-hooks reason names core.hooksPath", /core\.hooksPath/.test(reasonOf({ tool_name: "Bash", tool_input: { command: "git config core.hooksPath x" } })), true);
  check("cli reason names claude --settings", /claude --settings/.test(reasonOf({ tool_name: "Bash", tool_input: { command: "claude --settings x.json" } })), true);
}

// ── SESSIONSTART: fingerprint, never a block ───────────────────────────────────────────────────────
{
  const r = run({ hook_event_name: "SessionStart", session_id: "s1", source: "startup" });
  check("SessionStart exits 0", r.status, 0);
  let out = null;
  try {
    out = JSON.parse(r.stdout).hookSpecificOutput;
  } catch {
    /* asserted below */
  }
  check("SessionStart prints hookEventName SessionStart", out && out.hookEventName, "SessionStart");
  check("SessionStart never carries a permissionDecision", out && out.permissionDecision, undefined);
  const ctx = (out && out.additionalContext) || "";
  check("fingerprint line names a 12-hex digest over 2 files", /fingerprint [0-9a-f]{12} over 2 file\(s\)/.test(ctx), true);
  check("fingerprint lists .claude/hooks/goal-guard.mjs with an 8-hex hash", /  [0-9a-f]{8}  \.claude\/hooks\/goal-guard\.mjs/.test(ctx), true);
  check("fingerprint lists .claude/settings.json", /  [0-9a-f]{8}  \.claude\/settings\.json/.test(ctx), true);
  const before = /fingerprint ([0-9a-f]{12})/.exec(ctx)[1];
  writeFileSync(join(REPO, ".claude", "hooks", "goal-guard.mjs"), "// tampered\n");
  const ctx2 = JSON.parse(run({ hook_event_name: "SessionStart" }).stdout).hookSpecificOutput.additionalContext;
  const after = /fingerprint ([0-9a-f]{12})/.exec(ctx2)[1];
  check("a changed hook changes the fingerprint (the diff is visible)", before !== after, true);
  const ctx3 = JSON.parse(run({ hook_event_name: "SessionStart" }).stdout).hookSpecificOutput.additionalContext;
  check("the fingerprint is stable across two reads of the same tree", /fingerprint ([0-9a-f]{12})/.exec(ctx3)[1], after);
  const empty = run({ hook_event_name: "SessionStart", cwd: join(TREE, "nowhere") });
  check("no control surface → says 0 files, exits 0", empty.status === 0 && /0 files/.test(empty.stdout), true);
  const hatch = run({ hook_event_name: "SessionStart" }, { ...BASE_ENV, CONFIG_GUARD_ALLOW: "1" });
  check("SessionStart announces the hatch when it is set", /EXEMPTED this session/.test(hatch.stdout), true);
  check("SessionStart with a tool-shaped payload still never denies", verdict(run({ hook_event_name: "SessionStart", tool_name: "Bash", tool_input: { command: "rm .agent-scope" } })) !== "deny", true);
}

// ── HARNESS: fail-open on garbage, fail-closed on oversize, scoped by tool ─────────────────────────
{
  const r = run("not json{");
  check("garbage stdin → exit 0, no output (fail-open)", r.status === 0 && !r.stdout.trim(), true);
  const e = run("");
  check("empty stdin → exit 0, no output", e.status === 0 && !e.stdout.trim(), true);
  const big = run(JSON.stringify({ cwd: REPO, tool_name: "Bash", tool_input: { command: "x".repeat(MAX_EVENT_BYTES + 1) } }));
  check("oversize stdin is refused (fail-closed)", verdict(big), "deny");
  check("…and the reason says it was NOT scanned", /NOT scanned/.test(big.stdout), true);
  ALLOW("tool_name Read of a hook file", edit(".claude/hooks/goal-guard.mjs", "Read"));
  ALLOW("tool_name Glob is ignored", verdict(run({ tool_name: "Glob", tool_input: { pattern: ".claude/hooks/*" } })));
  ALLOW("Bash with no command field", verdict(run({ tool_name: "Bash", tool_input: {} })));
  ALLOW("Write with no file_path", verdict(run({ tool_name: "Write", tool_input: { content: "x" } })));
  ALLOW("Write with a non-string file_path", verdict(run({ tool_name: "Write", tool_input: { file_path: 42 } })));
  ALLOW("no tool_name at all", verdict(run({ tool_input: { command: "rm .agent-scope" } })));
  ALLOW("empty command", bash(""));
  ALLOW("missing cwd falls back to process.cwd (no crash)", verdict(run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }))));
  FIRE("missing cwd still judges a relative control path by shape", verdict(run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm .agent-scope" } }))));
}

// ── PURE DECIDERS: exported for the doctor and for mutation testing ────────────────────────────────
check("classifyPath: settings class", classifyPath(".claude/settings.json", REPO)?.cls, "settings");
check("classifyPath: hooks class", classifyPath(".claude/hooks/x.mjs", REPO)?.cls, "hooks");
check("classifyPath: managed class on the Windows path", classifyPath("C:\\Program Files\\ClaudeCode\\managed-settings.json", REPO)?.cls, "managed");
// A Windows HOME spells with backslashes, so `~/.claude.json` expands to a Windows SHAPE; the
// global-config check must still apply to it (it did not: three CI cases on the matrix).
check("classifyPath: ~/.claude.json with a Windows home is global-config", classifyPath("~/.claude.json", REPO, "C:\\Users\\Me")?.cls, "global-config");
check("classifyPath: $HOME/.claude.json with a Windows home is global-config", classifyPath("$HOME/.claude.json", REPO, "C:\\Users\\Me")?.cls, "global-config");
check("classifyPath: ~/notes/.claude.json with a Windows home is NOT global-config", classifyPath("~/notes/.claude.json", REPO, "C:\\Users\\Me"), null);
check("classifyPath: null for a skill", classifyPath(".claude/skills/x/SKILL.md", REPO), null);
check("classifyPath: a flag is not a path", classifyPath("-i", REPO), null);
check("decideBash: git-hooks kind for core.hooksPath", decideBash("git config core.hooksPath x", REPO)?.cls, "git-hooks");
check("decideBash: null for the twin", decideBash("git config user.name x", REPO), null);
check("lex: heredoc body is skipped", lex("cat <<EOF\n> .claude/settings.json\nEOF\nls").length, 2);
check("lex: quoted > is marked", lex('echo ">x"')[0][1].qs, 0);

console.log(`\n[config-tamper-guard.test] ${pairs} paired cases.`);
if (pairs < 70) {
  fails++;
  console.log(`✗ FAIL  fewer than 70 paired cases (${pairs})`);
}
if (fails) {
  console.error(`\n[config-tamper-guard.test] ${fails} failure(s).`);
  process.exit(1);
}
console.log("\n[config-tamper-guard.test] all cases passed.");
