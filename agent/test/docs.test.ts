import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { OBS_CONTRACT } from "../src/config.ts";

const ROOT = join(import.meta.dirname, "..");
const mdFiles = (): string[] => {
  const out: string[] = [];
  for (const f of readdirSync(ROOT)) if (f.endsWith(".md")) out.push(join(ROOT, f));
  for (const dir of ["obs", "copywriter"]) for (const f of readdirSync(join(ROOT, "personality", dir))) out.push(join(ROOT, "personality", dir, f));
  return out;
};

test("no em dashes in any doc or persona file, the house rule", () => {
  for (const f of mdFiles()) {
    const text = readFileSync(f, "utf8");
    assert.ok(!text.includes("—"), `${f} contains an em dash`);
  }
});

test("the knowledge base names the verified token address the guards allow", () => {
  const kb = readFileSync(join(ROOT, "OBSCURA_KB.md"), "utf8").toLowerCase();
  assert.ok(kb.includes(OBS_CONTRACT), "OBSCURA_KB.md carries the $OBS address");
});

test("the voice doc is for @ObscuraCEX and carries the hard rules", () => {
  const voice = readFileSync(join(ROOT, "OBS_X_VOICE.md"), "utf8");
  assert.match(voice, /@ObscuraCEX/);
  assert.match(voice, /NO EM DASHES/);
  assert.match(voice, /Privacy is the product/);
  assert.match(voice, /never tag or imply the company/);
});
