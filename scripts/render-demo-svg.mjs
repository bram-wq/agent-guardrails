#!/usr/bin/env node
// Render the output of demo.mjs as a static SVG terminal window → assets/demo.svg.
// Run: `node scripts/render-demo-svg.mjs`. Zero dependencies; the demo is run for real, so the
// picture can never drift from what the guards actually do.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, "assets", "demo.svg");

const r = spawnSync(process.execPath, [join(ROOT, "demo.mjs")], {
  encoding: "utf8",
  env: { ...process.env, HOOK_CTX: "test" },
});
if (r.status !== 0) {
  console.error(`demo.mjs exited ${r.status}; refusing to render a failing demo.\n${r.stdout}${r.stderr}`);
  process.exit(1);
}

const WIDTH = 900;
const PAD_X = 24;
const LINE_H = 20;
const FONT = 13;
const CHROME_H = 40;
const PAD_BOTTOM = 20;
const CHAR_W = FONT * 0.6; // monospace advance at 13px ≈ 7.8px

const COLORS = {
  bg: "#0d1117",
  chrome: "#161b22",
  border: "#30363d",
  text: "#c9d1d9",
  dim: "#8b949e",
  green: "#3fb950",
  red: "#f85149",
  yellow: "#d29922",
  blue: "#58a6ff",
  bold: "#f0f6fc",
};

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const span = (text, fill, weight) =>
  `<tspan fill="${fill}"${weight ? ` font-weight="${weight}"` : ""}>${esc(text)}</tspan>`;

// Colour one line. Every branch keeps the original characters (only wraps them), so the
// monospace column alignment demo.mjs built with padEnd survives.
function colorize(line) {
  if (line === "") return "";
  if (/^\S/.test(line) && !/^\d+ case|^Every guard/.test(line)) return span(line, COLORS.bold, "bold"); // hook name
  if (/^Every guard/.test(line)) return span(line, COLORS.green, "bold");
  if (/^\d+ case/.test(line)) return span(line, COLORS.red, "bold");
  if (/^\s+reason:/.test(line)) return span(line, COLORS.dim);
  const m = line.match(/^(\s+)([✔✘])(\s+)(must-(?:not-)?fire)(\s+)(.*?)(\s+→\s+)(REFUSED|WARNED|allowed)(.*)$/);
  if (!m) return span(line, COLORS.text);
  const [, i1, mark, i2, label, i3, cmd, arrow, verdict, rest] = m;
  return (
    span(i1, COLORS.text) +
    span(mark, mark === "✔" ? COLORS.green : COLORS.red, "bold") +
    span(i2 + label + i3, COLORS.dim) +
    span(cmd, COLORS.text) +
    span(arrow, COLORS.dim) +
    span(verdict, verdict === "REFUSED" ? COLORS.red : verdict === "WARNED" ? COLORS.yellow : COLORS.green, "bold") +
    span(rest, COLORS.dim)
  );
}

const lines = ["$ node demo.mjs", ...r.stdout.replace(/\r\n/g, "\n").replace(/^\n/, "").split("\n")];
while (lines.length && lines[lines.length - 1] === "") lines.pop();
const height = CHROME_H + PAD_BOTTOM + lines.length * LINE_H + 8;
// A reason line can run past the frame; clip it with an ellipsis rather than widen the picture.
const MAX_CHARS = Math.floor((WIDTH - 2 * PAD_X) / CHAR_W);
for (let i = 0; i < lines.length; i++)
  if (lines[i].length > MAX_CHARS) lines[i] = lines[i].slice(0, MAX_CHARS - 1) + "…";

const body = lines
  .map((l, i) => {
    const y = CHROME_H + 16 + i * LINE_H;
    const content = i === 0 ? span("$ ", COLORS.green) + span(l.slice(2), COLORS.text) : colorize(l);
    return `  <text x="${PAD_X}" y="${y}" xml:space="preserve">${content}</text>`;
  })
  .join("\n");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" font-size="${FONT}">
  <title>node demo.mjs — each guard fed the incident and its legitimate twin</title>
  <rect width="${WIDTH}" height="${height}" rx="10" fill="${COLORS.bg}" stroke="${COLORS.border}"/>
  <path d="M10 0 h${WIDTH - 20} a10 10 0 0 1 10 10 v${CHROME_H - 10} H0 V10 a10 10 0 0 1 10 -10 z" fill="${COLORS.chrome}"/>
  <circle cx="22" cy="${CHROME_H / 2}" r="6" fill="#ff5f56"/>
  <circle cx="42" cy="${CHROME_H / 2}" r="6" fill="#ffbd2e"/>
  <circle cx="62" cy="${CHROME_H / 2}" r="6" fill="#27c93f"/>
  <text x="${WIDTH / 2}" y="${CHROME_H / 2 + 4}" text-anchor="middle" fill="${COLORS.dim}" font-size="12">agent-guardrails — node demo.mjs</text>
${body}
</svg>
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, svg);
console.log(`wrote ${OUT} (${lines.length} lines, ${svg.length} bytes)`);
