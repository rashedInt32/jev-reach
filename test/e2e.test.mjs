// Browser tests. They launch a headless isolated Chrome through the stock
// chrome-devtools-mcp code path, so they need Chrome installed and run only
// with JEV_REACH_E2E=1. The scripted-Jev tests need no key; the live test
// additionally needs a TypeSafe key in the environment.

import assert from "node:assert/strict";
import test from "node:test";
import { KEY_VAR, payload, startFixture, startMockJev, textOf, withClient } from "./helpers.mjs";

const e2e = process.env.JEV_REACH_E2E === "1";
const gated = { skip: e2e ? false : "set JEV_REACH_E2E=1 to run browser tests" };
const live = { skip: e2e && process.env[KEY_VAR] ? false : `set JEV_REACH_E2E=1 and ${KEY_VAR} to run the live test` };

const ARGS = ["--isolated", "--headless", "--no-usage-statistics"];

/** Pick the first element whose description contains the wanted label. */
function pickByLabel(labels) {
  return (state, criteria) => {
    for (const want of labels) {
      const hit = Object.entries(criteria).find(([, desc]) => typeof desc === "string" && desc.includes(want));
      if (hit) return hit[0];
    }
    return "none";
  };
}

test("reach walks past the cookie banner to Settings and the console keeps the walk", gated, async () => {
  const site = await startFixture();
  const jev = await startMockJev({
    // On the home page prefer the consent button while it exists, then the Settings link.
    pick: (state, criteria) => {
      const consent = Object.entries(criteria).find(([, d]) => d.includes("Accept all cookies"));
      if (consent) return consent[0];
      return pickByLabel(["Settings"])(state, criteria);
    },
    goal: (state) => (state.url.endsWith("/settings.html") ? 0.95 : 0.05),
  });
  try {
    await withClient({ args: ARGS, env: { TYPESAFE_BASE_URL: jev.url } }, async (client) => {
      const result = await client.callTool({
        name: "reach",
        arguments: { goal: "Dismiss the cookie banner and open the Settings page", url: `${site.url}/` },
      });
      assert.equal(result.isError, undefined, textOf(result));
      const body = payload(result);
      assert.equal(body.status, "done", JSON.stringify(body, null, 2));
      assert.equal(typeof body.page_id, "number", "reach must hand back the stock page id");
      assert.ok(body.url.endsWith("/settings.html"), body.url);
      assert.equal(body.title, "Settings");
      assert.ok(body.steps.length >= 2, "expected at least the consent click and the settings click");
      assert.ok(body.steps.some((s) => s.target?.includes("Accept all cookies")), "consent was clicked");
      assert.ok(body.steps.some((s) => s.target?.includes("Settings")), "settings link was clicked");
      assert.ok(body.usage.calls >= 2);
      assert.ok(!JSON.stringify(body).includes("We use cookies"), "page text must not leak into the result");

      // Every Jev request carried only the names of values, never page-typed secrets.
      for (const req of jev.requests) assert.deepEqual(req.state.available_values, []);

      // The cold-buffer check: the walk happened before any stock tool call, yet
      // the console collector saw it.
      const console_ = await client.callTool({ name: "list_console_messages", arguments: { pageId: body.page_id } });
      const text = textOf(console_);
      assert.match(text, /settings-loaded/, `console after the walk:\n${text}`);
      const network = textOf(await client.callTool({ name: "list_network_requests", arguments: { pageId: body.page_id } }));
      assert.match(network, /settings\.json/, `network after the walk:\n${network}`);
    });
  } finally {
    await jev.close();
    await site.close();
  }
});

test("reach withholds an irreversible click and reports it as pending", gated, async () => {
  const site = await startFixture();
  const jev = await startMockJev({
    pick: pickByLabel(["Pay now"]),
    goal: () => 0.1,
  });
  try {
    await withClient({ args: ARGS, env: { TYPESAFE_BASE_URL: jev.url } }, async (client) => {
      const body = payload(await client.callTool({ name: "reach", arguments: { goal: "Complete the payment", url: `${site.url}/checkout.html` } }));
      assert.equal(body.status, "needs_confirmation", JSON.stringify(body, null, 2));
      assert.match(body.pending.target, /Pay now/);
      const text = textOf(await client.callTool({ name: "list_console_messages", arguments: { pageId: body.page_id } }));
      assert.doesNotMatch(text, /PAID/, "the payment button must not have been clicked");
    });
  } finally {
    await jev.close();
    await site.close();
  }
});

test("reach reports stuck when nothing changes", gated, async () => {
  const site = await startFixture();
  const jev = await startMockJev({ pick: () => "none", goal: () => 0.1 });
  try {
    await withClient({ args: ARGS, env: { TYPESAFE_BASE_URL: jev.url } }, async (client) => {
      const body = payload(await client.callTool({ name: "reach", arguments: { goal: "Something impossible", url: `${site.url}/checkout.html`, max_steps: 6 } }));
      assert.equal(body.status, "stuck", JSON.stringify(body, null, 2));
      assert.ok(Array.isArray(body.candidates) && body.candidates.length >= 1);
    });
  } finally {
    await jev.close();
    await site.close();
  }
});

test("live: the real Jev dismisses the banner and opens Settings", live, async () => {
  const site = await startFixture();
  try {
    await withClient({ args: ARGS, env: { [KEY_VAR]: process.env[KEY_VAR] } }, async (client) => {
      const body = payload(
        await client.callTool({
          name: "reach",
          arguments: { goal: "Dismiss the cookie consent dialog, then open the Settings page so its heading is visible.", url: `${site.url}/` },
        }),
      );
      assert.ok(["done", "likely_done"].includes(body.status), JSON.stringify(body, null, 2));
      assert.ok(body.url.endsWith("/settings.html"), JSON.stringify(body, null, 2));
      const text = textOf(await client.callTool({ name: "list_console_messages", arguments: { pageId: body.page_id } }));
      assert.match(text, /settings-loaded/);
    });
  } finally {
    await site.close();
  }
});

// Fixture credentials. Not real; they only unlock the local login page.
const FIXTURE_VALUES = { email: "dev@example.test", password: "hunter2" };

test("live: the real Jev signs in with supplied values and lands on Settings", live, async () => {
  const site = await startFixture();
  try {
    await withClient({ args: ARGS, env: { [KEY_VAR]: process.env[KEY_VAR] } }, async (client) => {
      const body = payload(
        await client.callTool({
          name: "reach",
          arguments: {
            goal: "Sign in with the supplied email and password so the Settings page is showing.",
            url: `${site.url}/login.html`,
            values: FIXTURE_VALUES,
          },
        }),
      );
      if (process.env.JEV_REACH_TEST_STDERR) console.error(JSON.stringify(body, null, 2));
      assert.ok(["done", "likely_done"].includes(body.status), JSON.stringify(body, null, 2));
      assert.ok(body.url.endsWith("/settings.html"), JSON.stringify(body, null, 2));
      assert.ok(!JSON.stringify(body).includes(FIXTURE_VALUES.password), "the secret must never appear in the result");
      // The stock console buffer is per navigation, so the login page's own
      // messages are gone once Settings loads; the current page's are there.
      const text = textOf(await client.callTool({ name: "list_console_messages", arguments: { pageId: body.page_id } }));
      assert.match(text, /settings-loaded/);
    });
  } finally {
    await site.close();
  }
});
