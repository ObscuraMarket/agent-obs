import { test } from "node:test";
import assert from "node:assert/strict";
import { Lru } from "../src/lru.ts";

test("the bounded map forgets the least recently used entry once it is full", () => {
  const m = new Lru<string, number>(3);
  m.set("a", 1).set("b", 2).set("c", 3);
  assert.equal(m.size, 3);
  m.set("d", 4);
  assert.deepEqual([...m.keys()], ["b", "c", "d"], "a was the oldest and is gone");
  assert.equal(m.get("a"), undefined);
  assert.equal(m.get("b"), 2, "a read makes b the most recently used");
  m.set("e", 5);
  assert.deepEqual([...m.keys()], ["d", "b", "e"], "c went, not b");
  assert.equal(m.peek("d"), 4);
  m.set("e", 6);
  assert.deepEqual([...m.keys()], ["d", "b", "e"], "a peek does not move d; a set of an existing key moves it to the end without growing");
  assert.equal(m.size, 3);
  assert.equal(m.delete("b"), true);
  assert.equal(m.has("b"), false);
  assert.deepEqual([...m], [["d", 4], ["e", 6]], "iteration is oldest first");
  for (const [k] of m) if (k === "d") m.delete(k);
  assert.deepEqual([...m.keys()], ["e"], "deleting while iterating is safe");
  m.clear();
  assert.equal(m.size, 0);
});

test("the bound is never below one, whatever it is asked for", () => {
  for (const max of [0, -5, Number.NaN]) {
    const m = new Lru<string, number>(max);
    m.set("only", 1).set("next", 2);
    assert.deepEqual([...m.keys()], ["next"], `max ${max} keeps exactly one`);
  }
  assert.equal(new Lru(2.9).max, 2, "a fraction rounds down");
});
