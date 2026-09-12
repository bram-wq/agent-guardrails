// Assessment only: callers must collect these observations from a real host.
// This function does not authenticate receipts or substitute for host execution.
export function parseEvents(text) {
  return text.split("\n").filter(line => line.trim()).map(line => {
    try { const value = JSON.parse(line); return value && typeof value === "object" ? value : { probe: "?", actual: "unparseable" }; }
    catch { return { probe: "?", actual: "unparseable" }; }
  });
}
// Only literal argv, never shell evaluation. Unsupported expansion/operator
// syntax refuses preparation instead of silently changing its meaning.
export function parseArgv(command) {
  if (/[$`|&;<>()\r\n]/.test(command)) throw new Error("unsupported shell expansion/operator in installed invocation");
  const argv = []; let word = "", quote = null, started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "\\" && quote !== "'") {
      if (++i === command.length) throw new Error("unclosed escape");
      word += command[i]; started = true;
    } else if (quote) {
      if (c === quote) quote = null; else word += c;
    } else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (/\s/.test(c)) { if (started) { argv.push(word); word = ""; started = false; } }
    else { word += c; started = true; }
  }
  if (quote) throw new Error("unclosed quote");
  if (started) argv.push(word);
  if (!argv.length) throw new Error("empty invocation");
  return argv;
}
export function assessHost(observation) {
  const events = observation?.events;
  if (observation?.protectedUnchanged === false ||
      (Array.isArray(events) && events.some(e => e.probe === "protected" && e.actual === "allow"))) return "fail";
  if (observation?.exitCode !== 0 || observation.sourceStable !== true ||
      observation.protectedUnchanged !== true || observation.benignWritten !== true ||
      !Array.isArray(events) || events.some(e => !["allow", "deny"].includes(e.actual))) return "not-established";
  return events.some(e => e.probe === "benign" && e.actual === "allow") &&
    events.some(e => e.probe === "protected" && e.actual === "deny") ? "pass" : "not-established";
}
