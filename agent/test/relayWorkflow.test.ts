import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The relay has two writers, the Actions workflow and the operator's relay-dashboard.sh, and one branch on the site
// repo. Until 2026-09-08 the workflow carried its own copy of the mapping from before the console existed, so a push
// to main rebuilt that branch without the console page the operator had just staged, and a run on a repo with no
// RELAY_TOKEN passed with a notice. These hold both writers to relay-apply.sh and one branch, and an unconfigured run
// to a failure.
const REPO = join(import.meta.dirname, "..", "..");
const read = (p: string): string => readFileSync(join(REPO, p), "utf8");
const workflow = read(".github/workflows/relay-dashboard.yml");
const operator = read("scripts/relay-dashboard.sh");
const BRANCH = "obs-dashboard-relay";

test("the workflow applies the mapping through relay-apply.sh and carries none of its own", () => {
  assert.match(workflow, /bash scripts\/relay-apply\.sh "\$GITHUB_WORKSPACE\/site" "\$\(git rev-parse --short "\$GITHUB_SHA"\)"/);
  assert.doesNotMatch(workflow, /rsync|cp dashboard\//, "the mapping lives in relay-apply.sh; the workflow copies nothing itself");
  for (const v of ["RELAY_PATH", "RELAY_DOCS", "RELAY_ASSETS"]) {
    assert.match(workflow, new RegExp(`${v}: \\$\\{\\{ vars\\.${v} \\}\\}`), `${v} reaches relay-apply.sh from the repo's variables`);
  }
});

test("the operator's relay makes the same call with the same variables", () => {
  assert.match(operator, /RELAY_PATH="\$APP" RELAY_DOCS="\$DOCS" RELAY_ASSETS="\$SITE_ASSETS" bash "\$ROOT\/scripts\/relay-apply\.sh" "\$TMP\/site" "\$SHA"/);
});

test("an unconfigured run fails with an error naming what is missing, never passes with a notice", () => {
  const step = workflow.slice(workflow.indexOf("Check the relay is configured"), workflow.indexOf("Check out this repo"));
  assert.match(step, /RELAY_REPO/);
  assert.match(step, /RELAY_TOKEN/);
  assert.match(step, /::error::/);
  assert.match(step, /exit 1/);
  assert.doesNotMatch(workflow, /::notice::|ok=false|if: \$\{\{ vars\.RELAY_REPO/);
});

test("both writers, the stage and the ship name one branch, and the workflow still opens the pull request", () => {
  assert.match(workflow, /uses: peter-evans\/create-pull-request@v6\n\s+with:\n\s+path: site\n/);
  assert.match(workflow, new RegExp(`branch: ${BRANCH}\\n`));
  assert.match(operator, new RegExp(`BRANCH="${BRANCH}"`));
  assert.match(read("scripts/stage-site.sh"), new RegExp(`--branch ${BRANCH}`));
  assert.match(read("scripts/ship-site.sh"), new RegExp(`--head ${BRANCH}`));
});

test("the trigger is a push to main that touches dashboard/, or a run by hand", () => {
  assert.match(workflow, /on:\n  push:\n    branches: \[main\]\n    paths: \["dashboard\/\*\*"\]\n  workflow_dispatch:/);
});
