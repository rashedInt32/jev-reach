// Offline tests for the pure helpers. No Chrome, no network, no key.

import assert from "node:assert/strict";
import test from "node:test";
import {
  bindingSatisfied,
  buildBindingOptions,
  chunk,
  consumedKeys,
  decideStep,
  describeCandidate,
  fingerprint,
  looksIrreversible,
  MAX_OPTIONS,
  Mutex,
  parseBinding,
  parsePages,
  parseSelectedPage,
  rankCandidates,
  statusOnBudget,
} from "../dist/lib.js";

const c = (ref, over = {}) => ({ ref, tag: "button", kind: "click", label: `Button ${ref}`, inViewport: true, ...over });

const neutral = { element: { choice: "none", confidence: 0.9 }, action: { choice: "click", confidence: 0.9 }, goal: 0.05, irreversible: 0.05, login: 0.05, blocked: 0.05 };

test("rankCandidates puts in-viewport elements first and keeps order otherwise", () => {
  const ranked = rankCandidates([c(1, { inViewport: false }), c(2), c(3, { inViewport: false }), c(4)]);
  assert.deepEqual(
    ranked.map((x) => x.ref),
    [2, 4, 1, 3],
  );
});

test("describeCandidate shows tag, label, state, href, and fold marker", () => {
  const d = describeCandidate({ ref: 1, tag: "link", kind: "click", label: "Settings", inViewport: false, href: "/settings", state: "expanded" });
  assert.equal(d, 'link "Settings" (expanded) -> /settings [below the fold]');
});

test("chunk splits at the option cap", () => {
  const items = Array.from({ length: MAX_OPTIONS * 2 + 1 }, (_, i) => i);
  const parts = chunk(items, MAX_OPTIONS);
  assert.equal(parts.length, 3);
  assert.equal(parts[2].length, 1);
});

test("binding options pair every typeable field with every value name and never the value", () => {
  const fields = [c(1, { kind: "type", tag: "input[email]", label: "Email" }), c(2, { kind: "type", tag: "input[password]", label: "Password" })];
  const options = buildBindingOptions(fields, ["email", "password"]);
  assert.deepEqual(Object.keys(options).sort(), ["e1|email", "e1|password", "e2|email", "e2|password"]);
  assert.ok(options["e1|email"].includes('named "email"'));
  assert.deepEqual(parseBinding("e2|password"), { ref: 2, key: "password" });
  assert.equal(parseBinding("none"), null);
});

test("bindingSatisfied drops filled fields so Jev is never offered a re-type", () => {
  const values = { email: "a@b.test", password: "pw" };
  const email = c(1, { kind: "type", tag: "input[email]", label: "Email", value: "", filled: false });
  const emailDone = { ...email, value: "a@b.test", filled: true };
  const pwd = c(2, { kind: "type", tag: "input[password]", label: "Password", filled: false });
  const pwdFilled = { ...pwd, filled: true };
  const typed = new Set(["input[password]|Password|password"]);

  assert.equal(bindingSatisfied(email, "email", values, new Set()), false);
  assert.equal(bindingSatisfied(emailDone, "email", values, new Set()), true);
  // A visible value that differs is not satisfied, even if typed before.
  assert.equal(bindingSatisfied({ ...email, value: "wrong", filled: true }, "email", values, new Set(["input[email]|Email|email"])), false);
  // Masked: filled alone is not enough, filled plus typed-this-run is.
  assert.equal(bindingSatisfied(pwdFilled, "password", values, new Set()), false);
  assert.equal(bindingSatisfied(pwdFilled, "password", values, typed), true);
  assert.equal(bindingSatisfied(pwd, "password", values, typed), false);

  const options = buildBindingOptions([emailDone, pwd], ["email", "password"], (cand, key) => bindingSatisfied(cand, key, values, new Set()));
  assert.deepEqual(Object.keys(options).sort(), ["e1|password", "e2|email", "e2|password"]);

  // Once the email sits in its field, "email" leaves the menu for every field.
  const consumed = consumedKeys([emailDone, pwd], ["email", "password"], values, new Set());
  assert.deepEqual([...consumed], ["email"]);
  const narrowed = buildBindingOptions([emailDone, pwd], ["email", "password"], (cand, key) => consumed.has(key) || bindingSatisfied(cand, key, values, new Set()));
  assert.deepEqual(Object.keys(narrowed).sort(), ["e1|password", "e2|password"]);
  // Both placed: nothing left to type.
  const all = consumedKeys([emailDone, pwdFilled], ["email", "password"], values, typed);
  assert.deepEqual([...all].sort(), ["email", "password"]);
});

test("looksIrreversible flags orders, payment, delete, send, publish but not search", () => {
  assert.ok(looksIrreversible("Place order"));
  assert.ok(looksIrreversible("Pay now"));
  assert.ok(looksIrreversible("Delete account"));
  assert.ok(looksIrreversible("Send message"));
  assert.ok(!looksIrreversible("Search"));
  assert.ok(!looksIrreversible("Accept all cookies"));
  assert.ok(!looksIrreversible("Submit"));
});

test("fingerprint changes with url, text, or inputs", () => {
  const base = { url: "http://x/", text: "hello", inputs: "" };
  assert.equal(fingerprint(base), fingerprint({ ...base }));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, url: "http://x/a" }));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, text: "hello!" }));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, inputs: "a" }));
});

test("parsePages reads ids, urls, and the selected marker in every list_pages shape", () => {
  assert.deepEqual(parsePages("## Pages\n1: Home (https://a.test/) \n2: Settings (https://a.test/settings) [selected]"), [
    { id: 1, url: "https://a.test/", selected: false },
    { id: 2, url: "https://a.test/settings", selected: true },
  ]);
  assert.deepEqual(parsePages("## Pages\n7: about:blank [selected]"), [{ id: 7, url: "about:blank", selected: true }]);
  assert.deepEqual(parsePages("## Pages\n3: Title with (parens) (https://a.test/x) [selected] isolatedContext=foo"), [{ id: 3, url: "https://a.test/x", selected: true }]);
  assert.deepEqual(parsePages("nothing here"), []);
  assert.deepEqual(parseSelectedPage("1: https://a.test/\n2: https://b.test/ [selected]"), { id: 2, url: "https://b.test/", selected: true });
  assert.equal(parseSelectedPage("1: https://a.test/"), null);
});

test("decideStep finishes on a reached goal before touching anything", () => {
  const d = decideStep({ ...neutral, element: { choice: "e1", confidence: 0.9 }, goal: 0.9 }, { candidates: [c(1)], hasValues: false, allowIrreversible: false });
  assert.deepEqual(d, { kind: "finish", status: "done" });
});

test("decideStep reports blocked and login walls", () => {
  assert.deepEqual(decideStep({ ...neutral, blocked: 0.8 }, { candidates: [], hasValues: false, allowIrreversible: false }), { kind: "finish", status: "blocked" });
  assert.deepEqual(decideStep({ ...neutral, login: 0.8 }, { candidates: [], hasValues: false, allowIrreversible: false }), { kind: "finish", status: "needs_login" });
  // With credentials supplied the walk continues.
  const d = decideStep({ ...neutral, login: 0.8, element: { choice: "e1", confidence: 0.9 } }, { candidates: [c(1)], hasValues: true, allowIrreversible: false });
  assert.equal(d.kind, "act");
});

test("decideStep withholds irreversible clicks unless allowed", () => {
  const pay = c(1, { label: "Pay now" });
  const held = decideStep({ ...neutral, element: { choice: "e1", confidence: 0.9 } }, { candidates: [pay], hasValues: false, allowIrreversible: false });
  assert.equal(held.kind, "confirm");
  const byJev = decideStep({ ...neutral, element: { choice: "e1", confidence: 0.9 }, irreversible: 0.7 }, { candidates: [c(1, { label: "Continue" })], hasValues: false, allowIrreversible: false });
  assert.equal(byJev.kind, "confirm");
  const allowed = decideStep({ ...neutral, element: { choice: "e1", confidence: 0.9 } }, { candidates: [pay], hasValues: false, allowIrreversible: true });
  assert.deepEqual(allowed, { kind: "act", action: "click", target: pay });
});

test("decideStep resolves select options and binds typed values", () => {
  const opt = c(3, { kind: "select", tag: "option", label: 'Canada in select "Country"' });
  assert.deepEqual(decideStep({ ...neutral, element: { choice: "e3", confidence: 0.9 } }, { candidates: [opt], hasValues: false, allowIrreversible: false }), { kind: "act", action: "select", target: opt });

  const email = c(5, { kind: "type", tag: "input[email]", label: "Email" });
  const typed = decideStep(
    { ...neutral, action: { choice: "type", confidence: 0.9 }, binding: { choice: "e5|email", confidence: 0.9 } },
    { candidates: [email], hasValues: true, allowIrreversible: false },
  );
  assert.deepEqual(typed, { kind: "act", action: "type", target: email, valueKey: "email" });

  const unbound = decideStep({ ...neutral, action: { choice: "type", confidence: 0.9 }, binding: { choice: "none", confidence: 0.9 } }, { candidates: [email], hasValues: true, allowIrreversible: false });
  assert.equal(unbound.kind, "ambiguous");
});

test("decideStep treats none, unknown, and low-confidence picks as ambiguous", () => {
  const ctx = { candidates: [c(1)], hasValues: false, allowIrreversible: false };
  assert.equal(decideStep({ ...neutral }, ctx).kind, "ambiguous");
  assert.equal(decideStep({ ...neutral, element: { choice: "e99", confidence: 0.9 } }, ctx).kind, "ambiguous");
  assert.equal(decideStep({ ...neutral, element: { choice: "e1", confidence: 0.1 } }, ctx).kind, "ambiguous");
});

test("decideStep passes through scroll, back, wait, and handles done", () => {
  const ctx = { candidates: [], hasValues: false, allowIrreversible: false };
  assert.deepEqual(decideStep({ ...neutral, action: { choice: "scroll_down", confidence: 0.9 } }, ctx), { kind: "act", action: "scroll_down" });
  assert.deepEqual(decideStep({ ...neutral, action: { choice: "done", confidence: 0.9 }, goal: 0.7 }, ctx), { kind: "finish", status: "likely_done" });
  assert.equal(decideStep({ ...neutral, action: { choice: "done", confidence: 0.9 }, goal: 0.2 }, ctx).kind, "noop");
});

test("statusOnBudget reports likely_done when the last goal read was promising", () => {
  assert.equal(statusOnBudget(0.7, "max_steps"), "likely_done");
  assert.equal(statusOnBudget(0.2, "max_steps"), "max_steps");
  assert.equal(statusOnBudget(null, "timeout"), "timeout");
});

test("Mutex serialises", async () => {
  const m = new Mutex();
  const order = [];
  const a = m.acquire().then(async (release) => {
    order.push("a-start");
    await new Promise((r) => setTimeout(r, 20));
    order.push("a-end");
    release();
  });
  const b = m.acquire().then((release) => {
    order.push("b");
    release();
  });
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a-start", "a-end", "b"]);
});
