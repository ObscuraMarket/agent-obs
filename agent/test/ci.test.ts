// The gate on the code: the workflow that runs on every push and pull request, and the deploy script that refuses a
// head that does not pass. Neither is code this runtime loads, so both are held as text, to the contract and not the
// prose: what runs, in what order, on which node, and that nothing goes up unchecked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..");
const ci = readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf8");
const deploy = readFileSync(join(REPO, "scripts", "deploy-desk.sh"), "utf8");

test("the workflow runs on every push and pull request, on node 22, every action pinned to a major version", () => {
  assert.match(ci, /^on:\n  push:\n  pull_request:\n/m);
  assert.match(ci, /^\s+node-version: 22$/m);
  const uses = ci.match(/^\s+uses: .+$/gm)?.map((l) => l.trim()) ?? [];
  assert.ok(uses.length >= 2, "checks out and sets up node");
  for (const u of uses) assert.match(u, /^uses: [\w.-]+\/[\w.-]+@v\d+$/, `${u} is pinned to a major version`);
});

test("the workflow installs, typechecks, tests and walks the console in agent/, in that order, the walk held to ten minutes", () => {
  assert.match(ci, /^\s+working-directory: agent$/m);
  const wanted = ["npm ci", "npm run typecheck", "npm test", "npm run console:walk"];
  const runs = (ci.match(/^\s+run: .+$/gm) ?? []).map((l) => l.trim().slice("run: ".length));
  assert.deepEqual(runs.filter((r) => wanted.includes(r)), wanted);
  assert.match(ci, /^\s+run: npm run console:walk\n\s+timeout-minutes: 10$/m, "the walk has its own ten minute timeout");
});

test("the deploy script typechecks and tests agent/ before any railway up, and refuses the head when either fails", () => {
  const gate = deploy.indexOf("check typecheck && check test");
  assert.ok(gate > 0, "the gate is there");
  assert.ok(gate < deploy.indexOf("railway up"), "the gate comes before railway up");
  assert.match(deploy, /cd "\$ROOT\/agent" && npm run --silent "\$1"/);
  assert.match(deploy, /does not pass its checks; nothing deployed and the stamp was not advanced"; exit 1/);
  // --force retries a failed head; it never skips the checks, so the line that gates must not read $1.
  const gateLine = deploy.slice(deploy.lastIndexOf("\n", gate) + 1, deploy.indexOf("\n", gate));
  assert.ok(!gateLine.includes("$1"), "the gate is not conditioned on --force");
});

test("no em dashes in the workflow or the deploy script, the house rule", () => {
  for (const [name, text] of [["ci.yml", ci], ["deploy-desk.sh", deploy]] as const) assert.ok(!text.includes("—"), `${name} contains an em dash`);
});
