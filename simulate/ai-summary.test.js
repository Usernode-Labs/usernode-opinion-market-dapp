#!/usr/bin/env node
/**
 * Tests for ai-summary.js — the GET /__om/ai-summary/:surveyId endpoint.
 *
 * No network: the platform LLM proxy is stubbed via the injectable
 * `httpPost` seam so we can assert the gating, JSON shape, and that the
 * in-memory TTL cache prevents a second upstream call. Run with:
 * `node simulate/ai-summary.test.js`.
 */

"use strict";

const assert = require("assert");
const createAiSummary = require("../ai-summary");

const APP_PUBKEY = "ut1zkj9p90e0w0hqsnmr70xmzdcvhrj80upajpw67eywszu2g0qknksl3mlms";
const ADMIN = "ut1adminadminadminadminadminadminadminadminadminadminqadmin";

let nextTxId = 1;
function tx(from, type, extra, ts) {
  const memo = Object.assign({ app: "opinion-market", type }, extra || {});
  return {
    tx_id: "tx" + (nextTxId++).toString().padStart(4, "0"),
    from_pubkey: from,
    destination_pubkey: APP_PUBKEY,
    amount: 1,
    memo: JSON.stringify(memo),
    created_at: 1700000000000 + (ts || nextTxId * 1000),
  };
}

// A binary survey with one bet so the market has odds for the prompt.
function rawTxsWithSurvey() {
  nextTxId = 1;
  const survey = {
    id: "qa1", title: "Test", question: "Will it rain tomorrow?",
    options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }],
    active_duration_ms: 30 * 86400000,
  };
  return [
    tx(ADMIN, "join", null, 0),
    tx(ADMIN, "create_survey", { survey }, 1000),
    tx(ADMIN, "place_bet", { survey: "qa1", option: "yes", side: "yes", credits: 40 }, 2000),
  ];
}

// A fake Anthropic Messages API response carrying valid pros/cons JSON.
function stubResponse() {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          sides: [
            { key: "yes", pros: ["Forecast shows clouds", "Humidity rising"], cons: ["Front may stall"] },
            { key: "no", pros: ["High pressure building"], cons: ["Models disagree", "Late-day storms possible"] },
          ],
        }),
      },
    ],
  };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function run() {
  let pass = 0, fail = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log("  ok    " + name); pass++; }
    catch (e) { console.log("  FAIL  " + name + "\n        " + e.message); fail++; }
  }
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail === 0 ? 0 : 1);
}

/* ── Tests ──────────────────────────────────────────────────────────── */

test("disabled when the LLM proxy token is absent", async () => {
  const ai = createAiSummary({
    appPubkey: APP_PUBKEY,
    genesisAccounts: [],
    getRawTransactions: rawTxsWithSurvey,
    // Explicitly no proxy creds → mimics staging/standalone.
    llmProxyUrl: "",
    llmProxyToken: "",
  });
  assert.strictEqual(ai.isEnabled(), false, "isEnabled false without a token");
  const out = await ai.getSummary("qa1");
  assert.deepStrictEqual(out, { enabled: false }, "getSummary returns { enabled: false }");
});

test("handleRequest short-circuits to { enabled: false } when disabled", async () => {
  const ai = createAiSummary({
    appPubkey: APP_PUBKEY, genesisAccounts: [],
    getRawTransactions: rawTxsWithSurvey,
    llmProxyUrl: "", llmProxyToken: "",
  });
  let captured = null;
  const res = {
    set() { return res; },
    status() { return res; },
    json(payload) { captured = payload; return res; },
  };
  const consumed = ai.handleRequest({ method: "GET" }, res, "/__om/ai-summary/qa1");
  assert.strictEqual(consumed, true, "handler consumes the matching path");
  assert.deepStrictEqual(captured, { enabled: false });
});

test("handleRequest ignores non-matching paths", async () => {
  const ai = createAiSummary({
    appPubkey: APP_PUBKEY, genesisAccounts: [],
    getRawTransactions: rawTxsWithSurvey,
    llmProxyUrl: "http://proxy", llmProxyToken: "tok",
  });
  const res = { set() { return res; }, json() { return res; }, status() { return res; } };
  assert.strictEqual(ai.handleRequest({ method: "GET" }, res, "/__om/pubkeys/qa1"), false);
});

test("enabled: returns sanitized pros/cons and caches (one upstream call)", async () => {
  let calls = 0;
  const ai = createAiSummary({
    appPubkey: APP_PUBKEY, genesisAccounts: [],
    getRawTransactions: rawTxsWithSurvey,
    llmProxyUrl: "http://proxy.local/api/app-llm",
    llmProxyToken: "test-token",
    httpPost: async (url, headers, body) => {
      calls++;
      // The proxy convention is honored.
      assert.strictEqual(headers["x-usernode-app-token"], "test-token", "forwards app token");
      assert.strictEqual(headers["anthropic-version"], "2023-06-01");
      assert(/\/v1\/messages$/.test(url), "calls /v1/messages");
      assert.strictEqual(body.model, createAiSummary.MODEL, "uses the haiku model");
      return stubResponse();
    },
  });

  assert.strictEqual(ai.isEnabled(), true);
  const first = await ai.getSummary("qa1");
  assert.strictEqual(first.enabled, true);
  assert.strictEqual(first.surveyId, "qa1");
  assert.strictEqual(first.sides.length, 2, "both sides returned");
  const yes = first.sides.find(s => s.key === "yes");
  assert(yes && yes.label === "Yes", "yes side carries its label");
  assert(yes.pros.length >= 1 && yes.cons.length >= 1, "yes has pros and cons");
  assert(yes.pros.length <= 3, "pros capped at 3");

  // Second call for the same survey must hit the cache — no upstream call.
  const second = await ai.getSummary("qa1");
  assert.strictEqual(calls, 1, "second getSummary served from cache (no extra upstream call)");
  assert.strictEqual(second.generatedAt, first.generatedAt, "same cached payload");
});

test("enabled: unknown survey id returns an empty-sides payload (no upstream call)", async () => {
  let calls = 0;
  const ai = createAiSummary({
    appPubkey: APP_PUBKEY, genesisAccounts: [],
    getRawTransactions: rawTxsWithSurvey,
    llmProxyUrl: "http://proxy", llmProxyToken: "tok",
    httpPost: async () => { calls++; return stubResponse(); },
  });
  const out = await ai.getSummary("does-not-exist");
  assert.strictEqual(out.enabled, true);
  assert.deepStrictEqual(out.sides, [], "no sides for an unknown survey");
  assert.strictEqual(calls, 0, "no upstream call when the survey isn't found");
});

run();
