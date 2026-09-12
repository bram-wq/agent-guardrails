// Behavioural test for secret-write-guard.mjs — run: `node hooks/secret-write-guard.test.mjs`.
//
// THE INCIDENT: `Write { file_path: ".env", content: "AWS_ACCESS_KEY_ID=AKIA…" }` — a live key, read
// from a session log, written to the tree and committed on the next turn.
//
// CONTRACT: a Write / Edit / MultiEdit / NotebookEdit whose NEW TEXT carries a credential, or a Bash
// command whose WRITTEN text does (heredoc body, `> file`, `tee`, `sed -i`, `sh -c`), is DENIED with a
// reason that names the RULE ID and the FILE:LINE and NEVER the value. Placeholders, decoys (git SHA,
// UUID), fixture paths, the rules file itself, and commands that only READ are allowed. The guard fails
// OPEN on a missing or malformed rules file (recording a fire of kind "error") and CLOSED above 1 MB.
//
// Every rule has a must-fire and its must-not-fire twin. Tokens are assembled by concatenation so this
// file is not itself a credential-shaped artefact. No framework; one line per case; non-zero on a miss.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide, loadRules, shannon, writtenText, MAX_EVENT_BYTES, DEFAULT_RULES_PATH } from "./secret-write-guard.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "secret-write-guard.mjs");
const TMP = mkdtempSync(join(tmpdir(), "swg-"));
const FIRE_LOG = join(TMP, "fires.log");
const BASE_ENV = (() => {
  const e = { ...process.env, HOOK_CTX: "test", HOOK_FIRE_LOG: FIRE_LOG };
  delete e.CLAUDE_HOOKS_QUIET;
  delete e.SECRET_GUARD_RULES;
  delete e.SECRET_GUARD_ALLOW_PATHS;
  return e;
})();

/** Feed raw stdin to the hook, exactly as Claude Code does. */
function feed(input, env = BASE_ENV) {
  const r = spawnSync(process.execPath, [HOOK], { input, encoding: "utf8", env, timeout: 20000 });
  if (r.status !== 0) return { verdict: `EXIT_${r.status}`, out: r.stdout ?? "", reason: "" };
  const out = (r.stdout ?? "").trim();
  if (!out) return { verdict: "allow", out, reason: "" };
  try {
    const j = JSON.parse(out);
    // No decision but a systemMessage: the guard is announcing it is OFF. Still an allow — the
    // write goes through — but the notice must be there, and the cases below assert it separately.
    if (!j.hookSpecificOutput && typeof j.systemMessage === "string") return { verdict: "allow", out, reason: j.systemMessage, off: true };
    const h = j.hookSpecificOutput;
    return { verdict: h.permissionDecision, out, reason: h.permissionDecisionReason ?? "" };
  } catch {
    return { verdict: `UNPARSEABLE:${out.slice(0, 40)}`, out, reason: "" };
  }
}
const ev = (tool_name, tool_input) => ({ tool_name, tool_input, cwd: TMP, hook_event_name: "PreToolUse" });
const run = (tool, input, env) => feed(JSON.stringify(ev(tool, input)), env);
const via = (tool, input, env) => run(tool, input, env).verdict;
const write = (file_path, content, env) => via("Write", { file_path, content }, env);
const bash = (command, env) => via("Bash", { command }, env);

let fails = 0;
let count = 0;
const check = (label, got, want) => {
  count++;
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${label} → want ${want}, got ${got}`);
};

// ── synthetic credentials (concatenated: high entropy, correct shape, never a real value) ──────────
const POOL = "aZ3bY7cX1dW9eV2fU8gT4hS6iR0jQ5kP1lO3mN2nB4C9D8E7F6G5H1I0JKq";
const alnum = (n) => (POOL + POOL.split("").reverse().join("")).slice(0, n);
const HEX = "3b1c9f0a2d4e6f8091a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4";
const AWS = "AKIA" + "J7Q2M4X9K1LP3ZRW";
const GH = "ghp_" + alnum(36);
const GL = "glpat-" + alnum(20);
const SLACK = "xoxb-" + "1234567890-" + alnum(24);
const STRIPE = "sk_live_" + alnum(24);
const GOOGLE = "AIza" + alnum(35);
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow" + alnum(40) + "\n-----END RSA PRIVATE KEY-----";
const NPM = "npm_" + alnum(36);
const ANT = "sk-ant-api03-" + alnum(40);
const OAI = "sk-proj-" + alnum(48);
const TWILIO = "SK" + HEX.slice(0, 32);
const SG = "SG." + alnum(22) + "." + alnum(43);
const DISCORD = "M" + alnum(24) + "." + alnum(6) + "." + alnum(30);
const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ." + alnum(43);
const GENERIC_VALUE = "Zq9!kL2#pR7vT4wX8yB1nM6cD3jF5hG0";
const SHA40 = HEX.slice(0, 40);
const UUID = "550e8400-e29b-41d4-a716-446655440000";
const VALUES = [AWS, GH, GL, SLACK, STRIPE, GOOGLE, NPM, ANT, OAI, TWILIO, SG, DISCORD, JWT, GENERIC_VALUE];

// ── MUST FIRE ★ the incident ──────────────────────────────────────────────────────────────────────
{
  const r = run("Write", { file_path: ".env", content: `AWS_ACCESS_KEY_ID=${AWS}\nAWS_SECRET_ACCESS_KEY=${alnum(40)}\n` });
  check("FIRE  ★ the incident: Write .env with a live AWS key", r.verdict, "deny");
  check("FIRE  …the reason names the rule id", /`aws-access-key-id`/.test(r.reason), true);
  check("FIRE  …and the file and line", /\.env, line 1\b/.test(r.reason), true);
  check("FIRE  …and never the value", r.reason.includes(AWS) || r.reason.includes(AWS.slice(4, 12)), false);
  check("FIRE  …and carries the fix", /SECRET_GUARD_ALLOW_PATHS|process\.env/.test(r.reason), true);
  check("FIRE  the pure decider returns the same reason", typeof decide(ev("Write", { file_path: ".env", content: `X=${AWS}` })), "string");
}

// ── MUST NOT FIRE ★ the twin, and the guard's own remediation advice ──────────────────────────────
check("ALLOW ★ the twin: .env.example with SECRET=changeme", write(".env.example", "SECRET=changeme\nDB_PASSWORD=changeme\n"), "allow");
check("ALLOW the remediation the deny reason recommends", write(".env.example", "MY_API_KEY=<your-key-here>\nSECRET=changeme\n"), "allow");
check("ALLOW the AWS docs' own example key (EXAMPLE placeholder)", write(".env.example", "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n"), "allow");
check("ALLOW the pure decider returns null for the twin", decide(ev("Write", { file_path: ".env.example", content: "SECRET=changeme" })), null);

// ── PER RULE: fire / twin ─────────────────────────────────────────────────────────────────────────
const P = "src/config.ts"; // an ordinary, non-exempt path
check("FIRE  github-token", write(P, `const t = "${GH}";`), "deny");
check("ALLOW github-token twin: xxxx placeholder body", write(P, `const t = "ghp_${"x".repeat(36)}";`), "allow");
check("FIRE  gitlab-pat", write(P, `GITLAB_TOKEN=${GL}`), "deny");
check("ALLOW gitlab-pat twin: <your-token-here>", write(P, "GITLAB_TOKEN=glpat-<your-token-here>"), "allow");
check("FIRE  slack-token", write(P, `SLACK_BOT_TOKEN=${SLACK}`), "deny");
check("ALLOW slack-token twin: REDACTED", write(P, "SLACK_BOT_TOKEN=xoxb-REDACTED-REDACTED"), "allow");
check("FIRE  stripe-live-key", write(P, `STRIPE_KEY=${STRIPE}`), "deny");
check("ALLOW stripe twin: sk_test_ is not a live key", write(P, `STRIPE_KEY=sk_test_${alnum(24)}`), "allow");
check("FIRE  google-api-key", write(P, `GOOGLE_KEY=${GOOGLE}`), "deny");
check("ALLOW google twin: EXAMPLE inside the span", write(P, `GOOGLE_KEY=AIzaSyEXAMPLE${alnum(26)}`), "allow");
check("FIRE  private-key-pem (RSA)", write("id_rsa", PEM), "deny");
check("FIRE  private-key-pem (unqualified header)", write("key.pem", "-----BEGIN PRIVATE KEY-----\nMIIE" + alnum(40)), "deny");
check("FIRE  private-key-pem (OPENSSH)", write("id_ed25519", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl" + alnum(40)), "deny");
check("ALLOW pem twin: a PUBLIC key", write("id_rsa.pub", "-----BEGIN PUBLIC KEY-----\nMIIB" + alnum(40) + "\n-----END PUBLIC KEY-----"), "allow");
check("ALLOW pem twin: a CERTIFICATE", write("cert.pem", "-----BEGIN CERTIFICATE-----\nMIID" + alnum(40)), "allow");
check("FIRE  npm-token", write(".npmrc", `//registry.npmjs.org/:_authToken=${NPM}`), "deny");
check("ALLOW npm twin: ${NPM_TOKEN} expansion", write(".npmrc", "//registry.npmjs.org/:_authToken=${NPM_TOKEN}"), "allow");
check("FIRE  anthropic-api-key", write(P, `ANTHROPIC_API_KEY=${ANT}`), "deny");
check("ALLOW anthropic twin: <your-key-here>", write(P, "ANTHROPIC_API_KEY=sk-ant-<your-key-here>"), "allow");
check("FIRE  openai-api-key (sk-proj-)", write(P, `OPENAI_API_KEY=${OAI}`), "deny");
check("FIRE  openai-api-key (bare sk- + 40)", write(P, `OPENAI_API_KEY=sk-${alnum(48)}`), "deny");
check("ALLOW openai twin: xxxx placeholder", write(P, `OPENAI_API_KEY=sk-proj-${"x".repeat(48)}`), "allow");
check("FIRE  twilio-api-key", write(P, `TWILIO_API_KEY=${TWILIO}`), "deny");
check("ALLOW twilio twin: the same shape under fixtures/", write("fixtures/twilio.json", `{"sid":"${TWILIO}"}`), "allow");
check("FIRE  sendgrid-api-key", write(P, `SENDGRID_API_KEY=${SG}`), "deny");
check("ALLOW sendgrid twin: placeholder segments", write(P, `SENDGRID_API_KEY=SG.${"x".repeat(22)}.${"x".repeat(43)}`), "allow");
check("FIRE  discord-bot-token", write(P, `DISCORD_TOKEN=${DISCORD}`), "deny");
check("ALLOW discord twin: the same token under testdata/", write("testdata/discord.txt", `DISCORD_TOKEN=${DISCORD}`), "allow");
check("FIRE  jwt in ordinary source", write(P, `const token = "${JWT}";`), "deny");
check("ALLOW jwt twin: in a test fixture (*.test.*)", write("auth/session.test.ts", `const token = "${JWT}";`), "allow");
check("FIRE  generic-credential: api_key = high-entropy value", write(P, `api_key = "${GENERIC_VALUE}"`), "deny");
check("FIRE  generic-credential: password: high-entropy value", write("config.yml", `db:\n  password: ${GENERIC_VALUE}\n`), "deny");
check("FIRE  generic-credential: TOKEN=… is case-insensitive", write(P, `TOKEN=${GENERIC_VALUE}`), "deny");
check("ALLOW generic twin: SECRET=changeme (short, placeholder)", write(P, "SECRET=changeme"), "allow");
check("ALLOW generic twin: password=<your-password-here>", write(P, "password=<your-password-here>"), "allow");
check("ALLOW generic twin: token = a 40-hex git SHA (decoy)", write(P, `token = "${SHA40}"`), "allow");
check("ALLOW generic twin: token = a 64-hex SHA-256 (decoy)", write(P, `token = "${HEX}"`), "allow");
check("ALLOW generic twin: token = a UUID (decoy)", write(P, `token = "${UUID}"`), "allow");
check("ALLOW generic twin: low-entropy value", write(P, `password = "aaaaaaaaaaaaaaaaaaaaaaaaaaaa"`), "allow");
check("ALLOW generic twin: ${VAR} reference", write(P, "API_KEY=${API_KEY_FROM_SSM}"), "allow");
check("ALLOW generic twin: {{ mustache }} reference", write(P, "api_key: {{ vault_api_key_value }}"), "allow");
check("ALLOW generic twin: REDACTED", write("log.txt", "token=REDACTED_REDACTED_REDACTED"), "allow");
check("ALLOW generic twin: process.env read, no value", write(P, "const apiKey = process.env.API_KEY;"), "allow");
check("ALLOW generic twin: a prose sentence with 'token' and no value", write("README.md", "Set the token: see the vault docs for how to get one."), "allow");
check("ALLOW a bare git SHA in a lockfile", write("package-lock.json", `"resolved": "git+ssh://git@github.com/x/y.git#${SHA40}"`), "allow");
check("ALLOW a base64 image data URI (with the word 'key' nearby)", write("index.html", `<p>keyboard</p><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==">`), "allow");

// ── TOOLS: Edit / MultiEdit / NotebookEdit / wrong tool ───────────────────────────────────────────
check("FIRE  Edit whose new_string carries the key", via("Edit", { file_path: P, old_string: "X=1", new_string: `X=${AWS}` }), "deny");
check("ALLOW Edit whose OLD string carries the key (removing it is not writing it)", via("Edit", { file_path: P, old_string: `X=${AWS}`, new_string: "X=<your-key-here>" }), "allow");
check("FIRE  MultiEdit: the second edit carries the key", via("MultiEdit", { file_path: P, edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: `k=${GH}` }] }), "deny");
check("ALLOW MultiEdit with clean edits", via("MultiEdit", { file_path: P, edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] }), "allow");
check("FIRE  NotebookEdit new_source carries the key", via("NotebookEdit", { notebook_path: "nb.ipynb", new_source: `os.environ["K"]="${ANT}"` }), "deny");
check("ALLOW NotebookEdit new_source reads from env", via("NotebookEdit", { notebook_path: "nb.ipynb", new_source: 'k = os.environ["ANTHROPIC_API_KEY"]' }), "allow");
check("ALLOW a non-write tool (Read) is ignored", via("Read", { file_path: P, content: `X=${AWS}` }), "allow");
check("ALLOW a non-write tool (Grep) is ignored", via("Grep", { pattern: AWS }), "allow");
check("ALLOW Write with no content field", via("Write", { file_path: P }), "allow");
check("ALLOW Write whose content is not a string", via("Write", { file_path: P, content: 42 }), "allow");
{
  const r = run("Write", { file_path: "deploy/env.txt", content: `A=1\nB=2\nC=${STRIPE}\n` });
  check("FIRE  the line number is the line in the file", /env\.txt, line 3\b/.test(r.reason), true);
  const r2 = run("Write", { file_path: "deploy/env.txt", content: `A=${AWS}\nB=${GH}\nC=${STRIPE}\n` });
  check("FIRE  several findings are all named", ["aws-access-key-id", "github-token", "stripe-live-key"].every((id) => r2.reason.includes(id)), true);
  check("FIRE  …and none of the values", VALUES.some((v) => r2.reason.includes(v)), false);
}

// ── PATHS: default allowlist, the rules file, the knob ────────────────────────────────────────────
check("ALLOW **/fixtures/**", write("packages/api/fixtures/aws.json", `{"k":"${AWS}"}`), "allow");
check("ALLOW **/__fixtures__/**", write("src/__fixtures__/aws.json", `{"k":"${AWS}"}`), "allow");
check("ALLOW **/testdata/**", write("cmd/testdata/aws.txt", AWS), "allow");
check("ALLOW **/*.test.* (absolute path)", write(join(TMP, "x", "guard.test.mjs"), `const k="${AWS}"`), "allow");
check("ALLOW **/*.spec.*", write("guard.spec.ts", `const k="${AWS}"`), "allow");
check("ALLOW the rules file itself (relative)", write("hooks/rules/secrets.json", `{"rules":[{"id":"x","regex":"${AWS}"}]}`), "allow");
check("ALLOW the rules file itself (absolute, resolved)", write(DEFAULT_RULES_PATH, `{"rules":[{"id":"x","regex":"${AWS}"}]}`), "allow");
check("FIRE  a look-alike path is not exempt (fixtures-old/)", write("src/fixtures-old/aws.json", `{"k":"${AWS}"}`), "deny");
check("FIRE  a file merely NAMED test.json is not *.test.*", write("config/test.json", `{"k":"${AWS}"}`), "deny");
{
  const env = { ...BASE_ENV, SECRET_GUARD_ALLOW_PATHS: "docs/examples/**, samples/*.md" };
  check("ALLOW SECRET_GUARD_ALLOW_PATHS: extra glob (first)", write("docs/examples/aws.md", AWS, env), "allow");
  check("ALLOW SECRET_GUARD_ALLOW_PATHS: extra glob (second, trimmed)", write("samples/keys.md", AWS, env), "allow");
  check("FIRE  SECRET_GUARD_ALLOW_PATHS does not widen beyond its globs", write("docs/aws.md", AWS, env), "deny");
}

// ── BASH: written text fires, reading does not ────────────────────────────────────────────────────
check("FIRE  Bash heredoc (unquoted tag) into .env", bash(`cat > .env <<EOF\nAWS_ACCESS_KEY_ID=${AWS}\nEOF`), "deny");
check("FIRE  Bash heredoc (quoted tag)", bash(`cat <<'EOF' > .env\nAWS_ACCESS_KEY_ID=${AWS}\nEOF`), "deny");
check("FIRE  Bash heredoc (<<- with tabs)", bash(`cat <<-EOF > .env\n\tKEY=${GH}\n\tEOF`), "deny");
check("FIRE  Bash unterminated heredoc keeps the rest (fires)", bash(`cat > .env <<EOF\nKEY=${GH}\n`), "deny");
check("FIRE  Bash echo > file", bash(`echo "AWS_ACCESS_KEY_ID=${AWS}" > .env`), "deny");
check("FIRE  Bash echo >> file", bash(`echo "GITHUB_TOKEN=${GH}" >> ~/.bashrc`), "deny");
check("FIRE  Bash printf > file", bash(`printf 'TOKEN=%s\\n' ${GL} > .gitlab.env`), "deny");
check("FIRE  Bash &> file", bash(`echo ${SLACK} &> creds.txt`), "deny");
check("FIRE  Bash tee", bash(`echo "STRIPE=${STRIPE}" | tee -a .env`), "deny");
check("FIRE  Bash sudo tee", bash(`echo "${ANT}" | sudo tee /etc/anthropic.key`), "deny");
check("FIRE  Bash sed -i payload", bash(`sed -i 's/^OPENAI_API_KEY=.*/OPENAI_API_KEY=${OAI}/' .env`), "deny");
check("FIRE  Bash sed --in-place payload", bash(`sed --in-place "s/CHANGEME/${NPM}/" .npmrc`), "deny");
check("FIRE  Bash sh -c hides the redirect in quotes", bash(`sh -c "echo KEY=${AWS} > .env"`), "deny");
check("FIRE  Bash write after a clean statement (&&)", bash(`git status && echo "TOKEN=${GH}" > .env`), "deny");
check("FIRE  Bash write on the second line", bash(`ls\necho "TOKEN=${GH}" > .env`), "deny");
{
  const r = run("Bash", { command: `ls\necho "TOKEN=${GH}" > .env` });
  check("FIRE  …the reason gives the command line", /command line 2\b/.test(r.reason), true);
  check("FIRE  …and never the value", r.reason.includes(GH) || r.reason.includes(GH.slice(4, 12)), false);
}
check("ALLOW Bash grep for a key is reading, not writing", bash(`grep -rn "${AWS}" . `), "allow");
check("ALLOW Bash grep AKIA prefix", bash("grep -rn AKIA . --include=*.env"), "allow");
check("ALLOW Bash cat .env is reading", bash("cat .env"), "allow");
check("ALLOW Bash echo of a key to stdout only (no redirect)", bash(`echo "${AWS}"`), "allow");
check("ALLOW Bash echo of a key to /dev/null", bash(`echo "${AWS}" > /dev/null`), "allow");
check("ALLOW Bash redirect of stderr only (2>&1) is not a file write", bash(`aws sts get-caller-identity --profile ${AWS} 2>&1`), "allow");
check("ALLOW Bash git commit -m message", bash(`git commit -m "chore: rotate the token; old id ${SHA40}"`), "allow");
check("ALLOW Bash git commit -m that mentions a key-shaped word", bash(`git commit -m "fix: reject AKIA-prefixed values in the loader"`), "allow");
check("ALLOW Bash heredoc twin: placeholders into .env.example", bash(`cat > .env.example <<'EOF'\nAWS_ACCESS_KEY_ID=<your-key-here>\nSECRET=changeme\nEOF`), "allow");
check("ALLOW Bash echo of a placeholder > file", bash(`echo "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE" > .env.example`), "allow");
check("ALLOW Bash tee of clean text", bash(`echo "hello" | tee out.txt`), "allow");
check("ALLOW Bash sed -i without a credential", bash(`sed -i 's/foo/bar/' src/x.ts`), "allow");
check("ALLOW Bash env-var indirection into a file", bash(`echo "AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID" > .env`), "allow");
check("ALLOW Bash clean multi-statement script", bash("npm test && git add -A && git commit -m 'ok'\necho done > status.txt"), "allow");
check("ALLOW Bash a > inside quotes is not a redirect", bash(`echo "a > b ${AWS}"`), "allow");
check("writtenText: reading command yields no pieces", writtenText(`grep ${AWS} .env`).length, 0);
check("writtenText: heredoc body is a piece with its line offset", JSON.stringify(writtenText("cat > f <<EOF\nbody\nEOF")[0]), JSON.stringify({ text: "body\n", lineOffset: 1 }));

// ── KNOBS: QUIET, SECRET_GUARD_RULES ──────────────────────────────────────────────────────────────
check("ALLOW CLAUDE_HOOKS_QUIET=1 lifts the guard", write(".env", `AWS_ACCESS_KEY_ID=${AWS}`, { ...BASE_ENV, CLAUDE_HOOKS_QUIET: "1" }), "allow");
check("FIRE  CLAUDE_HOOKS_QUIET=0 does not", write(".env", `AWS_ACCESS_KEY_ID=${AWS}`, { ...BASE_ENV, CLAUDE_HOOKS_QUIET: "0" }), "deny");
{
  const alt = join(TMP, "one-rule.json");
  writeFileSync(alt, JSON.stringify([{ id: "only-aws", regex: "\\bAKIA[0-9A-Z]{16}\\b" }]));
  const env = { ...BASE_ENV, SECRET_GUARD_RULES: alt };
  const r = run("Write", { file_path: ".env", content: `K=${AWS}` }, env);
  check("FIRE  SECRET_GUARD_RULES: the alternative file's rule fires", r.verdict, "deny");
  check("FIRE  …under its own rule id", /`only-aws`/.test(r.reason), true);
  check("ALLOW SECRET_GUARD_RULES: a rule absent from the alternative file does not fire", write(".env", `K=${GH}`, env), "allow");
  check("ALLOW SECRET_GUARD_RULES names the exempt rules file too", write(alt, `K=${AWS}`, env), "allow");
}
const fireLines = () => (existsSync(FIRE_LOG) ? readFileSync(FIRE_LOG, "utf8").split("\n").filter((l) => l.includes("\tfire\t")) : []);
const errorFires = () => fireLines().filter((l) => /\tfire\tsecret-write-guard\.mjs\terror\terror\t/.test(l)).length;
{
  const before = errorFires();
  const env = { ...BASE_ENV, SECRET_GUARD_RULES: join(TMP, "does-not-exist.json") };
  check("ALLOW a MISSING rules file fails open", write(".env", `K=${AWS}`, env), "allow");
{
  const off = run("Write", { file_path: ".env", content: `K=${AWS}` }, { ...BASE_ENV, SECRET_GUARD_RULES: join(TMP, "no-such-rules.json"), HOOK_FIRE_LOG: join(TMP, "off-notice-fires.log") }); // own log: the outage-count case below must not see this fire
  check("FIRE  …and SAYS SO: a missing rules file produces a systemMessage naming the guard as OFF", off.off === true && /secret-write-guard is OFF/.test(off.reason) ? "announced" : `silent:${off.out.slice(0, 40)}`, "announced");
  const on = run("Write", { file_path: "notes.md", content: "nothing secret here" });
  check("ALLOW no notice when the rules load and nothing fires (stdout stays empty)", on.out === "" ? "silent" : `noisy:${on.out.slice(0, 40)}`, "silent");
}
  check("…and records a fire of kind \"error\" (measurable outage)", errorFires() - before, 1);
}
{
  const bad = join(TMP, "bad.json");
  writeFileSync(bad, "not json{");
  const before = errorFires();
  check("ALLOW a MALFORMED rules file fails open", write(".env", `K=${AWS}`, { ...BASE_ENV, SECRET_GUARD_RULES: bad }), "allow");
  check("…and records a fire of kind \"error\"", errorFires() - before, 1);
}
{
  const bad = join(TMP, "badre.json");
  writeFileSync(bad, JSON.stringify([{ id: "broken", regex: "(" }]));
  check("ALLOW a rules file with a regex that does not compile fails open", write(".env", `K=${AWS}`, { ...BASE_ENV, SECRET_GUARD_RULES: bad }), "allow");
  check("loadRules reports the defect rather than throwing", typeof loadRules(bad).error, "string");
  const shape = join(TMP, "shape.json");
  writeFileSync(shape, JSON.stringify({ rules: "nope" }));
  check("ALLOW a rules file of the wrong shape fails open", write(".env", `K=${AWS}`, { ...BASE_ENV, SECRET_GUARD_RULES: shape }), "allow");
}
check("loadRules: the shipped file compiles", Array.isArray(loadRules(DEFAULT_RULES_PATH).rules), true);
check("shannon: a repeated char is 0 bits", shannon("aaaa"), 0);
check("shannon: the generic value clears the 3.5 floor", shannon(GENERIC_VALUE) >= 3.5, true);

// ── HARNESS: fail-open on garbage, fail-closed on oversize ────────────────────────────────────────
{
  const r = spawnSync(process.execPath, [HOOK], { input: "not json{", encoding: "utf8", env: BASE_ENV });
  check("ALLOW garbage stdin → exit 0, no output (fail-open)", r.status === 0 && !r.stdout.trim(), true);
  const e = spawnSync(process.execPath, [HOOK], { input: "", encoding: "utf8", env: BASE_ENV });
  check("ALLOW empty stdin → exit 0, no output", e.status === 0 && !e.stdout.trim(), true);
}
check("ALLOW an event with no tool_input", feed(JSON.stringify({ tool_name: "Write" })).verdict, "allow");
check("ALLOW an event with a null tool_input", feed(JSON.stringify({ tool_name: "Bash", tool_input: null })).verdict, "allow");
{
  const r = feed(JSON.stringify(ev("Write", { file_path: "big.txt", content: "x".repeat(MAX_EVENT_BYTES + 1) })));
  check("DENY  oversize stdin is refused, not waved through (fail-closed)", r.verdict, "deny");
  check("DENY  …and the reason says it was NOT scanned", /NOT scanned/.test(r.reason), true);
  const ok = feed(JSON.stringify(ev("Write", { file_path: "big.txt", content: "x".repeat(MAX_EVENT_BYTES - 4096) })));
  check("ALLOW a large but under-cap clean write", ok.verdict, "allow");
}
{
  const r = run("Write", { file_path: ".env", content: `K=${AWS}` });
  check("DENY  exit code is 0 on a deny (JSON decides, never exit 2)", r.verdict, "deny");
  check("DENY  the payload is the documented PreToolUse shape", JSON.parse(r.out).hookSpecificOutput.hookEventName, "PreToolUse");
}

// ── MUTATION CHECK: prove the suite can fail ──────────────────────────────────────────────────────
// A copy of the shipped rules with ONE rule's regex replaced by a never-matching pattern, loaded via the
// SECRET_GUARD_RULES knob. The must-fire for that rule MUST flip to allow while a sibling still fires:
// if it did not flip, the suite would be green with the rule's decision removed — and would prove nothing.
{
  const shipped = JSON.parse(readFileSync(DEFAULT_RULES_PATH, "utf8"));
  const mutated = { ...shipped, rules: shipped.rules.map((r) => (r.id === "aws-access-key-id" ? { ...r, regex: "(?!)" } : r)) };
  const mut = join(TMP, "mutated.json");
  writeFileSync(mut, JSON.stringify(mutated));
  const env = { ...BASE_ENV, SECRET_GUARD_RULES: mut };
  check("MUTATION: with aws-access-key-id disabled, the incident is ALLOWED (the test can fail)", write(".env", `AWS_ACCESS_KEY_ID=${AWS}`, env), "allow");
  check("MUTATION: …while a sibling rule still fires under the same copy", write(".env", `GITHUB_TOKEN=${GH}`, env), "deny");
  check("MUTATION: …and the shipped file, untouched, still denies the incident", write(".env", `AWS_ACCESS_KEY_ID=${AWS}`), "deny");
}

rmSync(TMP, { recursive: true, force: true });
if (fails) {
  console.error(`\n[secret-write-guard.test] ${fails} failure(s) in ${count} cases.`);
  process.exit(1);
}
console.log(`\n[secret-write-guard.test] all ${count} cases passed.`);
