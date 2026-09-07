import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedToolkits, resolveApp, appStatuses, appName, appsOn, mcpIdFor } from "../src/desk/apps.ts";
import { appsLines } from "../src/desk/deskConsole.ts";

test("the apps a person can connect come from the operator's list, and are named the way people name them", () => {
  assert.deepEqual(allowedToolkits({ OBS_APPS_TOOLKITS: " Slack, linear,,SLACK, gmail " } as NodeJS.ProcessEnv), ["slack", "linear", "gmail"]);
  assert.ok(allowedToolkits({} as NodeJS.ProcessEnv).includes("googledocs"), "the default list carries the docs");
  const allowed = ["slack", "linear", "twitter", "gmail", "googledocs", "googlesheets", "googlecalendar", "notion", "github"];
  for (const [said, slug] of [["Slack", "slack"], ["x", "twitter"], ["Twitter", "twitter"], ["google docs", "googledocs"], ["Docs", "googledocs"], ["GMail", "gmail"], ["email", "gmail"], ["sheets", "googlesheets"], ["calendar", "googlecalendar"], ["git", "github"], ["lin", "linear"]] as const) {
    assert.equal(resolveApp(said, allowed), slug, `${said} is ${slug}`);
  }
  assert.equal(resolveApp("tiktok", allowed), null);
  assert.equal(resolveApp("", allowed), null);
  assert.equal(resolveApp("x", ["slack"]), null, "a nickname for an app the operator did not allow is nothing");
  assert.equal(appName("twitter"), "X");
  assert.equal(appName("somethingnew"), "Somethingnew");
  assert.equal(appsOn({} as NodeJS.ProcessEnv), false);
  assert.equal(appsOn({ COMPOSIO_API_KEY: "k" } as NodeJS.ProcessEnv), true);
  assert.equal(mcpIdFor("0xABCdef"), "apps-abcdef");
});

test("what is connected reads at a glance, with the next tap offered", () => {
  const st = appStatuses(["slack", "gmail", "linear"], ["GMAIL"]);
  assert.deepEqual(st.map((a) => [a.name, a.connected]), [["Slack", false], ["Gmail", true], ["Linear", false]]);
  const lines = appsLines(st);
  assert.equal(lines[0], "Connected: Gmail.");
  assert.match(lines[1], /^You can connect: Slack, Linear\./);
  assert.match(lines[2], /\/apps connect Slack/);
  assert.equal(appsLines(appStatuses(["slack"], []))[0], "No apps connected yet.");
  assert.equal(appsLines(appStatuses(["slack"], ["slack"])).length, 1, "nothing left to offer");
});
