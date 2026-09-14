// Behavioural test for how init and uninstall write an existing settings file —
// run: `node bin/settings-write.test.mjs`.
//
// CONTRACT: the settings file is read ONCE. The backup holds exactly the bytes that were merged (odd
// formatting, CRLF and non-ASCII included), the new file replaces the old one whole through a temp file
// that is never left behind, and a settings path that cannot be read as JSON is refused with nothing
// written, no backup and no temp file. Drives the CLI as a child process, like agent-guardrails.test.mjs.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { scratchDir } from "../hooks/_scratch-dir.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "agent-guardrails.mjs");
const cli = (args, cwd) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, HOOK_CTX: "test" } });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${label} → want ${want}${ok ? "" : `, got ${got}`}`);
};
const claudeDir = (dir) => join(dir, ".claude");
const named = (dir, prefix) => readdirSync(claudeDir(dir)).filter((f) => f.startsWith(prefix));

// Deliberately NOT what JSON.stringify would produce: tabs, CRLF, non-ASCII, no trailing newline.
const ORIGINAL = Buffer.from(
  '{\r\n\t"permissions": { "allow": ["Bash(ls:*)"] },\r\n\t"note": "café — 日本"\r\n}',
  "utf8",
);

{
  const dir = scratchDir("agr-settings-init");
  mkdirSync(claudeDir(dir), { recursive: true });
  writeFileSync(join(claudeDir(dir), "settings.json"), ORIGINAL);
  const r = cli(["init"], dir);
  check("init over an existing settings file exits 0", r.code, 0);
  const backups = named(dir, "settings.json.bak-");
  check("init writes exactly one backup", backups.length, 1);
  check(
    "ALLOW the backup is byte-for-byte the file that was merged (CRLF, tabs, non-ASCII, no final newline)",
    backups.length === 1 && readFileSync(join(claudeDir(dir), backups[0])).equals(ORIGINAL),
    true,
  );
  let merged;
  try {
    merged = JSON.parse(readFileSync(join(claudeDir(dir), "settings.json"), "utf8"));
  } catch {
    merged = null;
  }
  check("the replaced settings file is valid JSON and keeps the foreign keys", merged?.note, "café — 日本");
  check("init leaves no temp file beside settings.json", named(dir, "settings.json.tmp-").length, 0);

  const beforeUninstall = readFileSync(join(claudeDir(dir), "settings.json"));
  const u = cli(["uninstall"], dir);
  check("uninstall exits 0", u.code, 0);
  const after = named(dir, "settings.json.bak-").filter((b) => !backups.includes(b));
  check("uninstall writes exactly one new backup", after.length, 1);
  check(
    "ALLOW the uninstall backup is byte-for-byte the file that was unmerged",
    after.length === 1 && readFileSync(join(claudeDir(dir), after[0])).equals(beforeUninstall),
    true,
  );
  check("uninstall leaves no temp file beside settings.json", named(dir, "settings.json.tmp-").length, 0);
}

{
  const dir = scratchDir("agr-settings-invalid");
  mkdirSync(claudeDir(dir), { recursive: true });
  const bad = Buffer.from("{ not json", "utf8");
  writeFileSync(join(claudeDir(dir), "settings.json"), bad);
  const r = cli(["init"], dir);
  check("FIRE  init refuses a settings file that is not valid JSON", r.code, 1);
  check("FIRE  …and leaves it untouched", readFileSync(join(claudeDir(dir), "settings.json")).equals(bad), true);
  check("FIRE  …with no backup and no temp file", named(dir, "settings.json.").length, 0);
  const u = cli(["uninstall"], dir);
  check("FIRE  uninstall refuses the same file", u.code, 1);
  check("FIRE  …and leaves it untouched", readFileSync(join(claudeDir(dir), "settings.json")).equals(bad), true);
}

{
  const dir = scratchDir("agr-settings-directory");
  mkdirSync(join(claudeDir(dir), "settings.json"), { recursive: true });
  const r = cli(["init"], dir);
  check("FIRE  init refuses a settings path that is a directory, instead of treating it as absent", r.code, 1);
  check("FIRE  …and names the path it refused", r.out.includes("refusing to touch"), true);
}

console.log(fails ? `\n${fails} case(s) FAILED` : "\nall cases passed");
process.exit(fails ? 1 : 0);
