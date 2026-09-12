#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cpSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { scratchDir, reapScratchDirs } from "../hooks/_scratch-dir.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const sha256 = value => createHash("sha256").update(value).digest("hex");
export function classify(result) {
  if (result.error || result.status !== 0) return "unknown";
  const text = (result.stdout ?? "").trim();
  if (!text) return "allow";
  try {
    const decision = JSON.parse(text)?.hookSpecificOutput?.permissionDecision;
    return ["deny", "allow"].includes(decision) ? decision : "unknown";
  } catch { return "unknown"; }
}
export function validateCorpus(corpus) {
  if (!corpus.version || !Array.isArray(corpus.cases) || !corpus.cases.length) throw new Error("empty corpus");
  const ids = new Set();
  for (const c of corpus.cases) {
    if (!c.id || ids.has(c.id) || !/^[a-z-]+-guard\.mjs$/.test(c.guard) ||
        !["deny", "allow"].includes(c.expected) || typeof c.command !== "string") throw new Error("invalid/duplicate case");
    ids.add(c.id);
  }
  for (const guard of new Set(corpus.cases.map(c => c.guard)))
    for (const expected of ["deny", "allow"])
      if (!corpus.cases.some(c => c.guard === guard && c.expected === expected)) throw new Error(`missing ${expected} control for ${guard}`);
}
export function summarize(results) {
  const attacks = results.filter(r => r.expected === "deny");
  const benign = results.filter(r => r.expected === "allow");
  return {
    population: { attacks: attacks.length, benign: benign.length, total: results.length },
    detection: { count: attacks.filter(r => r.actual === "deny").length, denominator: attacks.length },
    falsePositives: { count: benign.filter(r => r.actual === "deny").length, denominator: benign.length },
    unknown: results.filter(r => r.actual === "unknown").map(r => r.id),
  };
}
export function fileHashes(dir, prefix = "") {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) return Object.entries(fileHashes(join(dir, entry.name), relative + "/"));
    return entry.isFile() && !entry.name.endsWith(".test.mjs") ? [[relative, sha256(readFileSync(join(dir, entry.name)))]] : [];
  }));
}
export function writeReceipt(dir, name, report) {
  mkdirSync(dir, { recursive: true });
  const bytes = JSON.stringify(report, null, 2) + "\n";
  writeFileSync(join(dir, `${name}.json`), bytes, { flag: "wx" });
  writeFileSync(join(dir, `${name}.sha256`), `${sha256(bytes)}  ${name}.json\n`, { flag: "wx" });
}
export function evaluate() {
  const corpusBytes = readFileSync(join(ROOT, "eval/corpus.v1.json"));
  const corpus = JSON.parse(corpusBytes);
  validateCorpus(corpus);
  const scratch = scratchDir("guardrails-eval");
  const env = { ...process.env, HOOK_CTX: "test", HOOK_FIRE_LOG: join(scratch, "fires"), HOOK_STATE_DIR: join(scratch, "state") };
  for (const key of Object.keys(env))
    if (/^(CLAUDE_HOOKS_QUIET|PROSE_GUARD_ALLOW|FENCE_|SECRET_GUARD_|CONFIG_GUARD_ALLOW)/.test(key)) delete env[key];
  const hooks = join(ROOT, "hooks");
  const hashes = fileHashes(hooks);
  function runCase(c, directory) {
    const result = spawnSync(process.execPath, [join(directory, c.guard)], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: scratch,
        session_id: "evaluation", tool_input: { command: c.command } }),
      cwd: scratch, env, encoding: "utf8", timeout: 15000,
    });
    return { id: c.id, guard: c.guard, expected: c.expected, actual: classify(result) };
  }
  const results = corpus.cases.map(c => runCase(c, hooks));
  const mutations = [...new Set(corpus.cases.map(c => c.guard))].map((guard, index) => {
    const directory = join(scratch, `mutant-${index}`);
    cpSync(hooks, directory, { recursive: true });
    const path = join(directory, guard);
    const original = readFileSync(path, "utf8");
    const mutated = original.replaceAll(/permissionDecision:\s*"deny"/g, 'permissionDecision: "allow"');
    const base = { id: `${guard}:suppress-denial`, guard, originalSha256: sha256(original), mutantSha256: sha256(mutated) };
    if (mutated === original) return { ...base, status: "not-applicable", killedBy: [], benignRegressions: [] };
    writeFileSync(path, mutated);
    if (spawnSync(process.execPath, ["--check", path], { timeout: 15000 }).status !== 0)
      return { ...base, status: "invalid", killedBy: [], benignRegressions: [] };
    const outcomes = corpus.cases.filter(c => c.guard === guard).map(c => runCase(c, directory));
    const unknown = outcomes.filter(r => r.actual === "unknown").map(r => r.id);
    const killedBy = outcomes.filter(r => r.expected === "deny" && r.actual === "allow" && results.find(b => b.id === r.id).actual === "deny").map(r => r.id);
    const benignRegressions = outcomes.filter(r => r.expected === "allow" && r.actual !== "allow").map(r => r.id);
    return { ...base, status: unknown.length || benignRegressions.length ? "invalid" : killedBy.length ? "killed" : "survived", killedBy, benignRegressions, unknown };
  });
  const summary = summarize(results);
  const unchanged = JSON.stringify(hashes) === JSON.stringify(fileHashes(hooks));
  return { schemaVersion: 1, measuredAt: new Date().toISOString(), node: process.version,
    corpusVersion: corpus.version, corpusSha256: sha256(corpusBytes), scope: corpus.scope,
    hookHashes: hashes, reproduction: "node scripts/evaluate.mjs", ...summary,
    perGuard: Object.fromEntries([...new Set(results.map(r => r.guard))].map(g => [g, summarize(results.filter(r => r.guard === g))])),
    results, mutations, sourceUnchanged: unchanged,
    verdict: unchanged && results.every(r => r.actual === r.expected) && mutations.every(m => m.status === "killed") ? "pass" : "fail" };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 2 && args[0] === "--out")) throw new Error("usage: evaluate.mjs [--out fresh-directory]");
    const report = evaluate();
    if (args.length) writeReceipt(resolve(args[1]), "evaluation", report);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.verdict === "pass" ? 0 : 1;
  } catch (error) { console.error(`evaluation: ${error.message}`); process.exitCode = 2; }
  finally { reapScratchDirs(); }
}
