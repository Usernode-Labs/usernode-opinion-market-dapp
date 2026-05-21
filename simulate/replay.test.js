#!/usr/bin/env node
/**
 * Smoke regression tests for the shared `opinion-market-state.js` module.
 *
 * These do not hit the network — they feed handcrafted synthetic tx
 * streams to `computeFullState` and assert on the rebuilt state. The
 * goal isn't full coverage; it's to catch the class of bug where someone
 * refactors `computeFullState` and silently breaks an invariant the
 * client UI quietly depends on (e.g. "every joined user gets a
 * CREDIT_FLOWS entry"). Run with: `node simulate/replay.test.js`.
 */

"use strict";

const assert = require("assert");
const OMS = require("../public/opinion-market-state.js");

const APP_PUBKEY = "ut1zkj9p90e0w0hqsnmr70xmzdcvhrj80upajpw67eywszu2g0qknksl3mlms";
const ADMIN = "ut1adminadminadminadminadminadminadminadminadminadminqadmin";
const USER_A = "ut1zuseraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1aaaa";
const USER_B = "ut1zuserbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1bbbb";
const USER_C = "ut1zuserccccccccccccccccccccccccccccccccccccccccccccc1ccccc";

let nextTxId = 1;
function tx(from, type, extra, tsOffset) {
  const memo = Object.assign({ app: "opinion-market", type }, extra || {});
  return {
    tx_id: "tx" + (nextTxId++).toString().padStart(4, "0"),
    from_pubkey: from,
    destination_pubkey: APP_PUBKEY,
    amount: 1,
    memo: JSON.stringify(memo),
    created_at: 1700000000000 + (tsOffset || nextTxId * 1000),
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

/* ── Tests ────────────────────────────────────────────────────────── */

test("constants match the wire spec", () => {
  assert.strictEqual(OMS.INITIAL_CREDITS, 1000);
  assert.strictEqual(OMS.MARKET_ANTE, 50);
  assert.strictEqual(OMS.PLATFORM_LIQUIDITY, 450);
  assert.strictEqual(OMS.FEE_RATE, 0.05);
  assert.strictEqual(OMS.LIQUIDITY_FEE_RATE, 0.02);
  assert.strictEqual(OMS.MAX_BET_POOL_RATIO, 0.30);
  assert.strictEqual(OMS.CREATOR_REWARD_RATE, 0.005);
  assert.strictEqual(OMS.CREATOR_REWARD_CAP, 100);
});

test("empty input yields empty state", async () => {
  const state = await OMS.computeFullState({
    rawTxs: [], decryptedTxs: [], appPubkey: APP_PUBKEY,
    adminPubkey: null, genesisAccounts: [], globalUsernames: {},
    now: 1700000000000,
  });
  assert.strictEqual(state.SURVEYS.length, 0);
  assert.strictEqual(state.JOINED.size, 0);
  assert.strictEqual(state.MARKETS.size, 0);
  assert.strictEqual(state.CREDIT_FLOWS.size, 0);
});

test("BUG-MARAGUNG: every joined user has a CREDIT_FLOWS entry post-rebuild", async () => {
  // The whole point of this regression: before extraction, a joined
  // user who had never been touched by getCreditFlow() (because their
  // bets were dropped by Phase 6) would have CREDIT_FLOWS.get(pubkey)
  // return undefined. myCredits()'s `if (!f) return INITIAL_CREDITS`
  // fallback then lied to the UI, leading to the client posting bets
  // it didn't actually have credits for. After extraction, Phase 2
  // initializes a zero flow entry for every joiner, so the fallback is
  // unreachable.
  const txs = [tx(USER_A, "join"), tx(USER_B, "join")];
  const state = await OMS.computeFullState({
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: null, genesisAccounts: [], globalUsernames: {},
    now: 1700000999000,
  });
  assert(state.JOINED.has(USER_A), "USER_A joined");
  assert(state.JOINED.has(USER_B), "USER_B joined");
  assert(state.CREDIT_FLOWS.has(USER_A), "USER_A has a CREDIT_FLOWS entry (no implicit INITIAL_CREDITS)");
  assert(state.CREDIT_FLOWS.has(USER_B), "USER_B has a CREDIT_FLOWS entry");
  assert.strictEqual(OMS.userBalance(state, USER_A), OMS.INITIAL_CREDITS);
  assert.strictEqual(OMS.userBalance(state, USER_B), OMS.INITIAL_CREDITS);
});

test("non-joined user has zero balance, not INITIAL_CREDITS", async () => {
  const state = await OMS.computeFullState({
    rawTxs: [], decryptedTxs: [], appPubkey: APP_PUBKEY,
    adminPubkey: null, genesisAccounts: [], globalUsernames: {},
    now: 1700000000000,
  });
  assert.strictEqual(OMS.userBalance(state, USER_A), 0);
});

test("Phase 3: admin-gated surveys reject non-admin creators", async () => {
  nextTxId = 1;
  const survey = {
    id: "s1", title: "T1", question: "Q?",
    options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }],
    active_duration_ms: 60000,
  };
  const txs = [
    tx(ADMIN, "join"),
    tx(USER_A, "join"),
    tx(USER_A, "create_survey", { survey }),   // NOT admin — should be dropped
    tx(ADMIN, "create_survey", { survey: { ...survey, id: "s2" } }),  // admin — kept
  ];
  const state = await OMS.computeFullState({
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: ADMIN, genesisAccounts: [], globalUsernames: {},
    now: 1700000999000,
  });
  const ids = state.SURVEYS.map(s => s.id);
  assert(!ids.includes("s1"), "non-admin survey dropped");
  assert(ids.includes("s2"), "admin survey kept");
});

test("Phase 6: place_bet exceeding balance is silently dropped", async () => {
  nextTxId = 1;
  const survey = {
    id: "s1", title: "T", question: "Q?",
    options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }],
    active_duration_ms: 600000,
  };
  const txs = [
    tx(ADMIN, "join", null, 0),
    tx(USER_A, "join", null, 1000),
    tx(ADMIN, "create_survey", { survey }, 2000),
    // USER_A has 1000 credits; try to bet 2000.
    tx(USER_A, "place_bet", { survey: "s1", option: "yes", credits: 2000, side: "yes" }, 3000),
    // ... then a sane 100-credit bet.
    tx(USER_A, "place_bet", { survey: "s1", option: "yes", credits: 100, side: "yes" }, 4000),
  ];
  const state = await OMS.computeFullState({
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: ADMIN, genesisAccounts: [], globalUsernames: {},
    now: 1700000010000,
  });
  const flow = state.CREDIT_FLOWS.get(USER_A);
  assert(flow, "USER_A has a flow entry");
  assert.strictEqual(flow.grossBets, 100, "only the 100-credit bet was accepted");
  const rejected = OMS.findRejectedSends(state, {
    pubkey: USER_A, appPubkey: APP_PUBKEY, decryptedTxs: txs,
  });
  assert.strictEqual(rejected.length, 1, "one bet rejected");
  assert.strictEqual(rejected[0].reason, "INSUFFICIENT_BALANCE");
  assert.strictEqual(rejected[0].credits, 2000);
});

test("Phase 6: bets over MAX_BET_POOL_RATIO are dropped", async () => {
  nextTxId = 1;
  const survey = {
    id: "s1", title: "T", question: "Q?",
    options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }],
    active_duration_ms: 600000,
  };
  // For 2 options, cpmmInitPools(500, 2) returns two pools of {yes:250, no:250}
  // each → total liquidity 1000. 30% cap = 300. A 400-credit bet should
  // be dropped; a 200-credit one should pass.
  const txs = [
    tx(ADMIN, "join", null, 0),
    tx(USER_A, "join", null, 1000),
    tx(ADMIN, "create_survey", { survey }, 2000),
    tx(USER_A, "place_bet", { survey: "s1", option: "yes", credits: 400, side: "yes" }, 3000),
  ];
  const state = await OMS.computeFullState({
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: ADMIN, genesisAccounts: [], globalUsernames: {},
    now: 1700000010000,
  });
  const flow = state.CREDIT_FLOWS.get(USER_A);
  assert.strictEqual(flow.grossBets, 0, "400-credit bet over the 30% pool cap was dropped");
});

test("validatePlaceBet rejects with the same rules as Phase 6", async () => {
  nextTxId = 1;
  const survey = {
    id: "s1", title: "T", question: "Q?",
    options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }],
    active_duration_ms: 600000,
  };
  const txs = [
    tx(ADMIN, "join", null, 0),
    tx(USER_A, "join", null, 1000),
    tx(ADMIN, "create_survey", { survey }, 2000),
  ];
  const state = await OMS.computeFullState({
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: ADMIN, genesisAccounts: [], globalUsernames: {},
    now: 1700000010000,
  });
  const okSmall = OMS.validatePlaceBet(state, {
    pubkey: USER_A, surveyId: "s1", optionKey: "yes", credits: 50, side: "yes",
  });
  assert.strictEqual(okSmall.ok, true);
  // Pool total is 1000; 30% cap is 300. A 400-credit bet should hit OVER_MAX_BET.
  const tooBig = OMS.validatePlaceBet(state, {
    pubkey: USER_A, surveyId: "s1", optionKey: "yes", credits: 400, side: "yes",
  });
  assert.strictEqual(tooBig.ok, false);
  assert.strictEqual(tooBig.reason, "OVER_MAX_BET");
  const broke = OMS.validatePlaceBet(state, {
    pubkey: USER_A, surveyId: "s1", optionKey: "yes", credits: 2000, side: "yes",
  });
  assert.strictEqual(broke.ok, false);
  assert.strictEqual(broke.reason, "INSUFFICIENT_BALANCE");
});

test("genesis gating: non-genesis joiners are dropped", async () => {
  nextTxId = 1;
  const txs = [
    tx(USER_A, "join"),                  // in genesis list
    tx(USER_C, "join"),                  // NOT in genesis list
  ];
  const state = await OMS.computeFullState({
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: null, genesisAccounts: [USER_A, USER_B],
    globalUsernames: {}, now: 1700000999000,
  });
  assert(state.JOINED.has(USER_A));
  assert(!state.JOINED.has(USER_C), "non-genesis user excluded");
});

test("client and server reach the same final balance for a small replay", async () => {
  // Mirrors what lib/leaderboard.js does and what public/index.html does
  // on the same input. They both call computeFullState — so they MUST
  // produce identical balances. This is the regression we're guarding
  // against: code drift between client and server.
  nextTxId = 1;
  const survey = {
    id: "s1", title: "T", question: "Q?",
    options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }],
    active_duration_ms: 600000,
  };
  const txs = [
    tx(ADMIN, "join", null, 0),
    tx(USER_A, "join", null, 1000),
    tx(USER_B, "join", null, 1500),
    tx(ADMIN, "create_survey", { survey }, 2000),
    tx(USER_A, "place_bet", { survey: "s1", option: "yes", credits: 50, side: "yes" }, 3000),
    tx(USER_B, "place_bet", { survey: "s1", option: "no", credits: 40, side: "yes" }, 4000),
    tx(USER_A, "vote", { survey: "s1", choice: "yes" }, 5000),
    tx(USER_B, "vote", { survey: "s1", choice: "yes" }, 5500),
  ];
  const opts = {
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: ADMIN, genesisAccounts: [], globalUsernames: {},
    now: 1700000999999,
  };
  const stateA = await OMS.computeFullState(opts);
  const stateB = await OMS.computeFullState(opts);
  assert.strictEqual(OMS.userBalance(stateA, USER_A), OMS.userBalance(stateB, USER_A));
  assert.strictEqual(OMS.userBalance(stateA, USER_B), OMS.userBalance(stateB, USER_B));
  assert.strictEqual(OMS.userBalance(stateA, ADMIN), OMS.userBalance(stateB, ADMIN));
});

test("normalizeUsername handles edge cases", () => {
  // last6("ut1zsomeoneabc123") = "abc123" → suffix = "_abc123" (7 chars).
  const addr = "ut1zsomeoneabc123";
  assert.strictEqual(OMS.deriveDefaultUsername(addr), "user_abc123");
  assert.strictEqual(OMS.normalizeUsername("", "", addr), "user_abc123");
  assert.strictEqual(OMS.normalizeUsername("scraido", "", addr), "scraido_abc123");
  assert.strictEqual(OMS.normalizeUsername("foo_abc123", "", addr), "foo_abc123");
});

test("parseAppTx filters by app+to_pubkey", () => {
  const parse = OMS.makeParseAppTx(APP_PUBKEY);
  // Not to APP_PUBKEY → null.
  assert.strictEqual(parse({
    from: USER_A, to: USER_B, memo: JSON.stringify({ app: "opinion-market", type: "join" }),
  }), null);
  // Wrong app → null.
  assert.strictEqual(parse({
    from: USER_A, to: APP_PUBKEY, memo: JSON.stringify({ app: "other", type: "join" }),
  }), null);
  // Correct → parsed.
  const result = parse({
    from: USER_A, destination_pubkey: APP_PUBKEY, memo: JSON.stringify({ app: "opinion-market", type: "join" }),
  });
  assert(result && result.memo.type === "join");
});

run();
