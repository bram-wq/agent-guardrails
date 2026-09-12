import assert from "node:assert/strict";
const { assessHost, parseArgv, parseEvents } = await import("./host-proof.mjs");
const healthy = { exitCode: 0, sourceStable: true, protectedUnchanged: true, benignWritten: true,
  events: [{ probe: "benign", actual: "allow" }, { probe: "protected", actual: "deny" }] };
assert.equal(assessHost(healthy), "pass");
assert.equal(assessHost({ ...healthy, events: healthy.events.slice(1) }), "not-established");
assert.equal(assessHost({ ...healthy, events: [] }), "not-established");
assert.equal(assessHost({ ...healthy, exitCode: 1 }), "not-established");
assert.equal(assessHost({ ...healthy, sourceStable: false }), "not-established");
assert.equal(assessHost({ ...healthy, benignWritten: false }), "not-established");
assert.equal(assessHost({ ...healthy, protectedUnchanged: false }), "fail");
assert.equal(assessHost({ ...healthy, events: [...healthy.events, { probe: "protected", actual: "allow" }] }), "fail");
console.log("✓ host proof requires both observed controls, unchanged installed bytes and actual file outcomes");
assert.deepEqual(parseArgv('node "/path with spaces/adapter.mjs" a,b --flag'), ["node", "/path with spaces/adapter.mjs", "a,b", "--flag"]);
assert.throws(() => parseArgv('node "$HOME/adapter.mjs"'), /unsupported/);
assert.throws(() => parseArgv('node "unfinished'), /unclosed/);
assert.deepEqual(parseEvents('{"probe":"benign","actual":"allow"}\n{"probe":'), [
  { probe: "benign", actual: "allow" }, { probe: "?", actual: "unparseable" },
]);
assert.equal(assessHost({ ...healthy, events: [...healthy.events, ...parseEvents('{')] }), "not-established");
console.log("✓ invocation parsing preserves spaces and flags; truncated events invalidate rather than erase evidence");
