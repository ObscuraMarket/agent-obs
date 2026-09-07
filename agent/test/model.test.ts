import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelChoice, noModelWhy, personaText, anthropicRequest, openaiRequest, textOf, errorOf, reasonOf, modelFromEnv, DEFAULT_ANTHROPIC_MODEL } from "../src/desk/model.ts";

test("the environment names the model: the gateway first, then an Anthropic key, then an OpenAI-shape endpoint", () => {
  assert.equal(modelChoice({}), null);
  assert.deepEqual(modelChoice({ OPENHERMIT_GATEWAY_URL: "http://gw:4000", GATEWAY_ADMIN_TOKEN: "t", ANTHROPIC_API_KEY: "k" }), { kind: "gateway", baseUrl: "http://gw:4000", token: "t" });
  assert.equal(modelChoice({ OPENHERMIT_GATEWAY_URL: "http://gw:4000" }), null, "a gateway without its token is no gateway");
  assert.deepEqual(modelChoice({ ANTHROPIC_API_KEY: "k" }), { kind: "anthropic", key: "k", model: DEFAULT_ANTHROPIC_MODEL });
  assert.deepEqual(modelChoice({ ANTHROPIC_API_KEY: "k", OBS_MODEL: "claude-sonnet-5" }), { kind: "anthropic", key: "k", model: "claude-sonnet-5" });
  assert.deepEqual(modelChoice({ OBS_MODEL_URL: "https://openrouter.ai/api/v1/", OBS_MODEL_KEY: "r", OBS_MODEL: "x/y" }), { kind: "openai", url: "https://openrouter.ai/api/v1", key: "r", model: "x/y" });
  assert.deepEqual(modelChoice({ OBS_MODEL_URL: "http://127.0.0.1:11434/v1", OBS_MODEL: "llama" }), { kind: "openai", url: "http://127.0.0.1:11434/v1", key: null, model: "llama" });
  assert.equal(modelChoice({ OBS_MODEL_URL: "http://127.0.0.1:11434/v1" }), null, "an endpoint without a model name is not usable");
  assert.match(noModelWhy({ OBS_MODEL_URL: "http://x" }), /OBS_MODEL does not name/);
  assert.match(noModelWhy({}), /ANTHROPIC_API_KEY/);
});

test("the requests carry the persona as the system prompt and the key where each provider wants it", () => {
  const a = anthropicRequest({ kind: "anthropic", key: "sk", model: "m" }, "be OBS", "decide");
  assert.equal(a.url, "https://api.anthropic.com/v1/messages");
  assert.equal(a.headers["x-api-key"], "sk");
  assert.ok(a.headers["anthropic-version"]);
  assert.equal(a.body.system, "be OBS");
  assert.deepEqual(a.body.messages, [{ role: "user", content: "decide" }]);
  const o = openaiRequest({ kind: "openai", url: "http://h/v1", key: "r", model: "m" }, "be OBS", "decide");
  assert.equal(o.url, "http://h/v1/chat/completions");
  assert.equal(o.headers.authorization, "Bearer r");
  assert.deepEqual(o.body.messages, [{ role: "system", content: "be OBS" }, { role: "user", content: "decide" }]);
  const bare = openaiRequest({ kind: "openai", url: "http://h/v1", key: null, model: "m" }, "", "decide");
  assert.equal(bare.headers.authorization, undefined, "no key, no bearer");
  assert.deepEqual(bare.body.messages, [{ role: "user", content: "decide" }], "no persona, no system message");
});

test("the text is read from either reply shape, and a refusal keeps the provider's reason", () => {
  assert.equal(textOf("anthropic", { content: [{ type: "text", text: "THOUGHT: a" }, { type: "text", text: "DECISION: hold" }] }), "THOUGHT: a\nDECISION: hold");
  assert.equal(textOf("anthropic", { content: [] }), null);
  assert.equal(textOf("openai", { choices: [{ message: { role: "assistant", content: " DECISION: hold " } }] }), "DECISION: hold");
  assert.equal(textOf("openai", { choices: [] }), null);
  assert.equal(textOf("openai", "garbage"), null);
  assert.equal(errorOf(401, { error: { message: "invalid x-api-key" } }), "HTTP 401: invalid x-api-key");
  assert.equal(errorOf(502, null), "HTTP 502");
});

test("the persona files become one system prompt without their headings, and a missing file is skipped", () => {
  const root = mkdtempSync(join(tmpdir(), "obs-persona-"));
  mkdirSync(join(root, "personality", "obs"), { recursive: true });
  writeFileSync(join(root, "personality", "obs", "identity.md"), "# identity\n\nYou are OBS.\n");
  writeFileSync(join(root, "personality", "obs", "rules.md"), "# rules\n\nNo em dashes.\n");
  assert.equal(personaText("obs", root), "You are OBS.\n\nNo em dashes.");
  assert.equal(personaText("nobody", root), "");
});

test("a direct model posts the prompt and returns the text, and every failure comes back as a reason, never a throw", async () => {
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fake = (async (url: string | URL | globalThis.Request, init?: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ content: [{ type: "text", text: "DECISION: hold" }] }), { status: 200 });
  }) as typeof fetch;
  const m = modelFromEnv({ ANTHROPIC_API_KEY: "sk", OBS_MODEL: "m" }, fake, () => "be OBS");
  assert.ok(m);
  assert.equal(m.kind, "anthropic");
  assert.ok(!m.name.includes("sk"), "the name never carries the key");
  assert.deepEqual(await m.think("decide"), { text: "DECISION: hold" });
  assert.equal(seen[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(seen[0].body.system, "be OBS");
  const refused = modelFromEnv({ OBS_MODEL_URL: "http://h/v1", OBS_MODEL: "m" }, (async () => new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 })) as typeof fetch, () => "");
  assert.deepEqual(await refused!.think("decide"), { text: null, error: "HTTP 429: quota" });
  const empty = modelFromEnv({ OBS_MODEL_URL: "http://h/v1", OBS_MODEL: "m" }, (async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })) as typeof fetch, () => "");
  assert.deepEqual(await empty!.think("decide"), { text: null, error: "the model returned no text" });
  const down = modelFromEnv({ OBS_MODEL_URL: "http://h/v1", OBS_MODEL: "m" }, (async () => { throw new Error("connect ECONNREFUSED"); }) as typeof fetch, () => "");
  assert.deepEqual(await down!.think("decide"), { text: null, error: "connect ECONNREFUSED" });
  const wrapped = modelFromEnv({ OBS_MODEL_URL: "http://h/v1", OBS_MODEL: "m" }, (async () => { throw new Error("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }) }); }) as typeof fetch, () => "");
  assert.deepEqual(await wrapped!.think("decide"), { text: null, error: "fetch failed (connect ECONNREFUSED 127.0.0.1:9)" }, "the cause behind Node's fetch failed is said");
  assert.equal(reasonOf(Object.assign(new Error("aborted"), { name: "AbortError" })), "no answer in 90 s");
  assert.equal(reasonOf("x"), "x");
  assert.equal(modelFromEnv({}), null);
});
