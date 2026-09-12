// Transparent observer: forwards the installed handler's output and exit status.
import { readFileSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { classify } from "./evaluate.mjs";
const descriptor = JSON.parse(readFileSync(process.argv[2], "utf8"));
const input = readFileSync(0, "utf8");
const result = spawnSync(descriptor.executable, descriptor.args, {
  input, encoding: "utf8", timeout: descriptor.timeoutMs ?? 8000, cwd: process.cwd(), env: process.env,
});
try {
  const event = JSON.parse(input);
  const probe = Object.entries(descriptor.probes).find(([, command]) => command === event.tool_input?.command)?.[0];
  if (descriptor.eventsPath)
    appendFileSync(descriptor.eventsPath,
      JSON.stringify({ probe: probe ?? "unsupported", actual: result.status === null ? "observer-timeout" : classify(result),
        ...(probe ? {} : { payloadKeys: Object.keys(event), toolInputKeys: Object.keys(event.tool_input ?? {}) }) }) + "\n");
} catch { /* Missing observation cannot pass the independent assessment. */ }
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exitCode = result.status ?? 2;
