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

// Trading is enabled for every market kind, including the daily-BTC
// oracle market (its PR #19 trade gate was removed for issue #31, June
// 2026). The Phase-6 trade tests below (balance-cap rejection,
// MAX_BET_POOL_RATIO cap, validatePlaceBet preflight) apply to normal
// surveys; the BTC-specific test asserts the lazy platform-liquidity
// seed lets the FIRST bet on a server-authored market go through.

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

test("BTC market is tradeable: first bet lazily seeds it from platform liquidity", async () => {
  nextTxId = 1;
  const SERVER_ADDR = "ut1zserverserverserverserverserverserverserverserver1srv";
  const btcSv = {
    id: "btc-x", title: "Daily BTC",
    question: "Will BTC be higher or lower than $68,000 by tomorrow?",
    options: [{ key: "higher", label: "Higher" }, { key: "lower", label: "Lower" }],
    active_duration_ms: 86400000, kind: "btc_daily", strike_usd: 68000, priced_at: 0,
  };
  const normalSv = {
    id: "n1", title: "T", question: "Q?",
    options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }],
    active_duration_ms: 600000,
  };
  const txs = [
    tx(ADMIN, "join", null, 0),
    tx(USER_A, "join", null, 1000),
    tx(SERVER_ADDR, "create_daily_btc", { survey: btcSv }, 500),
    tx(ADMIN, "create_survey", { survey: normalSv }, 2000),
    // BTC bet: no Phase 5b market exists (createdBy is null), so Phase 6
    // must lazily seed one from platform liquidity and process the bet.
    tx(USER_A, "place_bet", { survey: "btc-x", option: "higher", credits: 100, side: "yes" }, 3000),
    // The same bet against a normal survey is also processed.
    tx(USER_A, "place_bet", { survey: "n1", option: "yes", credits: 100, side: "yes" }, 4000),
  ];
  const state = await OMS.computeFullState({
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: ADMIN, genesisAccounts: [], globalUsernames: {}, now: 1700000010000,
  });
  // BTC market was lazily seeded by the first bet and USER_A holds shares.
  const bmkt = state.MARKETS.get("btc-x");
  assert(bmkt, "BTC market lazily seeded by the first bet");
  assert(bmkt.userShares[USER_A] && bmkt.userShares[USER_A]["higher"] > 0, "BTC bet accrued YES shares");
  const nmkt = state.MARKETS.get("n1");
  assert(nmkt, "normal survey market seeded by Phase 5b");
  assert(nmkt.userShares[USER_A] && nmkt.userShares[USER_A]["yes"] > 0, "normal bet accrued YES shares");
  const flow = state.CREDIT_FLOWS.get(USER_A);
  assert.strictEqual(flow.grossBets, 200, "both bets counted");
  const btcRejects = state.rejectedSends.filter(r => r.surveyId === "btc-x");
  assert.strictEqual(btcRejects.length, 0, "BTC bet was not rejected");
  // validatePlaceBet accepts both fundable bets.
  const vBtc = OMS.validatePlaceBet(state, { pubkey: USER_A, surveyId: "btc-x", optionKey: "higher", credits: 10, side: "yes" });
  assert.strictEqual(vBtc.ok, true, "BTC bet passes preflight");
  const vNormal = OMS.validatePlaceBet(state, { pubkey: USER_A, surveyId: "n1", optionKey: "yes", credits: 10, side: "yes" });
  assert.strictEqual(vNormal.ok, true, "fundable normal bet passes preflight");
});

test("first bet on an unseeded market passes validatePlaceBet (issue #31)", async () => {
  // Server-authored markets (daily BTC, World Cup) and promoted proposals
  // have createdBy: null, so Phase 5b never seeds them and MARKETS has no
  // entry until the first bet. The preflight used to reject NO_MARKET
  // here, which blocked the first bet forever — the lazy seed could
  // never run. It must now validate against the platform-liquidity seed
  // Phase 6 would create.
  nextTxId = 1;
  const SERVER_ADDR = "ut1zserverserverserverserverserverserverserverserver1srv";
  const kickoff = 1700000000000 + 50000000;
  const wcMatch = {
    id: "wc26-m1", matchId: "wc26-m1",
    title: "Mexico vs Poland",
    question: "Mexico vs Poland — home win, draw, or away win?",
    options: [
      { key: "home_win", label: "Home win" },
      { key: "draw", label: "Draw" },
      { key: "away_win", label: "Away win" },
    ],
    kind: "wc26_match", stage: "group", group: "A",
    home_team: "MEX", away_team: "POL",
    home_team_name: "Mexico", away_team_name: "Poland",
    kickoff_ms: kickoff,
    active_duration_ms: 50000000 + 8 * 3600000,
    reveal_interval_ms: null,
  };
  const txs = [
    tx(USER_A, "join", null, 0),
    tx(SERVER_ADDR, "create_wc26_match", { match: wcMatch }, 500),
  ];
  const state = await OMS.computeFullState({
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: ADMIN, genesisAccounts: [], globalUsernames: {}, now: 1700000010000,
  });
  const sv = state.SURVEYS_BY_ID.get("wc26-m1");
  assert(sv, "World Cup survey registered");
  assert.strictEqual(state.MARKETS.has("wc26-m1"), false, "no market until the first bet");
  const v = OMS.validatePlaceBet(state, {
    pubkey: USER_A, surveyId: "wc26-m1", optionKey: "home_win", credits: 50,
    side: "yes", now: 1700000010000,
  });
  assert.strictEqual(v.ok, true, "first bet on an unseeded market passes preflight");
  // The max-bet cap is computed against the would-be lazy seed, exactly
  // as Phase 6 enforces it once the market exists.
  const seeded = OMS.seedMarketForSurvey(sv);
  const cap = Math.floor(OMS.cpmmTotalLiquidity(seeded) * OMS.MAX_BET_POOL_RATIO);
  const over = OMS.validatePlaceBet(state, {
    pubkey: USER_A, surveyId: "wc26-m1", optionKey: "home_win", credits: cap + 1,
    side: "yes", now: 1700000010000,
  });
  assert.strictEqual(over.ok, false);
  assert.strictEqual(over.reason, "OVER_MAX_BET");
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

test("BUG-INLINE-SETTLEMENT: payouts from settled surveys are spendable by later bets", async () => {
  // The bug this guards against: prior to inline settlement, Phase 6
  // walked all bets first and Phase 7 settled afterwards. So a user who
  // bet on survey A, had A expire+settle with a payout, and then tried
  // to bet on survey B using that payout — the bet on B was silently
  // dropped because Phase 6's balance check didn't know about the
  // payout (Phase 7 hadn't run yet in the chronological walk).
  //
  // Concrete repro: ADMIN creates two surveys A and B. USER_A votes on
  // A and bets 800 on the "yes" option of A. A expires; A's "yes" wins;
  // USER_A's payout comes to ~1500-ish credits (more than the initial
  // 1000). USER_A then tries to bet 600 on B, which should pass because
  // their post-A-settlement balance is well above 600 — they had 200
  // left after the 800 bet, plus a ~1500 payout.
  nextTxId = 1;
  const TX_BASE = 1700000000000;
  const surveyA = {
    id: "sA", title: "A", question: "Q?",
    options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }],
    active_duration_ms: 60000,
  };
  const surveyB = {
    id: "sB", title: "B", question: "Q?",
    options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }],
    active_duration_ms: 600000,
  };
  // USER_A spends 800 of their 1000 credits on A (4x 200; under the
  // 30% pool cap which grows after each bet). Pre-A-settlement balance:
  // 200. After A's "yes" wins (USER_A voted yes), USER_A's payout from
  // their yes-shares brings balance well above 250. A 250-bet on B at
  // ts 70000 then sits within B's 30%-of-1000-seed cap (300) but
  // EXCEEDS USER_A's pre-payout balance (200) — exactly the scenario
  // that was silently dropped pre-fix.
  const txs = [
    tx(ADMIN, "join", null, 0),
    tx(USER_A, "join", null, 1000),
    tx(ADMIN, "create_survey", { survey: surveyA }, 2000),
    tx(USER_A, "place_bet", { survey: "sA", option: "yes", credits: 200, side: "yes" }, 3000),
    tx(USER_A, "place_bet", { survey: "sA", option: "yes", credits: 200, side: "yes" }, 4000),
    tx(USER_A, "place_bet", { survey: "sA", option: "yes", credits: 200, side: "yes" }, 5000),
    tx(USER_A, "place_bet", { survey: "sA", option: "yes", credits: 200, side: "yes" }, 6000),
    tx(USER_A, "vote", { survey: "sA", choice: "yes" }, 7000),
    tx(ADMIN, "create_survey", { survey: surveyB }, 10000),
    tx(USER_A, "place_bet", { survey: "sB", option: "yes", credits: 250, side: "yes" }, 70000),
  ];
  const state = await OMS.computeFullState({
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: ADMIN, genesisAccounts: [], globalUsernames: {},
    now: TX_BASE + 80000,
  });
  const flow = state.CREDIT_FLOWS.get(USER_A);
  assert(flow.payouts > 0, "USER_A received a payout from survey A (got " + flow.payouts + ")");
  assert.strictEqual(flow.grossBets, 200 * 4 + 250, "all 5 bets accepted (got " + flow.grossBets + ")");
  const myRejects = state.rejectedSends.filter(r => r.from === USER_A);
  assert.strictEqual(myRejects.length, 0, "no silent rejections for USER_A (got " + myRejects.length + ")");
});

test("interleaved settlement: snapshot balance >= bet amount for every accepted bet", async () => {
  // Stronger invariant: after the fix, a re-rebuild over the tx prefix
  // ending just before an accepted bet must yield a userBalance >= the
  // bet amount. If this fails, the inline-settlement bug is back —
  // Phase 6 accepted a bet using a balance that the next rebuild won't
  // reproduce, which is exactly the silently-rejected-bet scenario.
  nextTxId = 1;
  const TX_BASE = 1700000000000;
  const surveyA = {
    id: "sA", title: "A", question: "Q?",
    options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }],
    active_duration_ms: 60000,
  };
  const surveyB = {
    id: "sB", title: "B", question: "Q?",
    options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }],
    active_duration_ms: 600000,
  };
  const txs = [
    tx(ADMIN, "join", null, 0),
    tx(USER_A, "join", null, 1000),
    tx(ADMIN, "create_survey", { survey: surveyA }, 2000),
    tx(USER_A, "place_bet", { survey: "sA", option: "yes", credits: 200, side: "yes" }, 3000),
    tx(USER_A, "place_bet", { survey: "sA", option: "yes", credits: 200, side: "yes" }, 4000),
    tx(USER_A, "place_bet", { survey: "sA", option: "yes", credits: 200, side: "yes" }, 5000),
    tx(USER_A, "place_bet", { survey: "sA", option: "yes", credits: 200, side: "yes" }, 6000),
    tx(USER_A, "vote", { survey: "sA", choice: "yes" }, 7000),
    tx(ADMIN, "create_survey", { survey: surveyB }, 10000),
    tx(USER_A, "place_bet", { survey: "sB", option: "yes", credits: 250, side: "yes" }, 70000),
  ];
  const fullOpts = {
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: ADMIN, genesisAccounts: [], globalUsernames: {},
    now: TX_BASE + 80000,
  };
  const fullState = await OMS.computeFullState(fullOpts);
  const flowA = fullState.CREDIT_FLOWS.get(USER_A);
  assert.strictEqual(flowA.grossBets, 200 * 4 + 250, "250-credit bet on B was accepted (grossBets=" + flowA.grossBets + ")");

  const beforeBet = txs.filter(t => t.created_at < TX_BASE + 70000);
  const snapState = await OMS.computeFullState(Object.assign({}, fullOpts, {
    rawTxs: beforeBet, decryptedTxs: beforeBet, now: TX_BASE + 69999,
  }));
  const snapBal = OMS.userBalance(snapState, USER_A);
  assert(snapBal >= 250, "snapshot balance " + snapBal + " at the moment of the 250 bet must be >= 250");
});

/* ── Proposals (Phase 3a) ─────────────────────────────────────────── */

const PROP = { title: "Best lunch?", question: "Where?", options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }] };
function proposalId(from) { return OMS.normalizeProposalDefinition(PROP, from).id; }
function propose(from, ts) { return tx(from, "propose_question", { proposal: PROP }, ts); }
function upvote(from, pid, ts) { return tx(from, "upvote_proposal", { proposal: pid }, ts); }

async function build(txs, now) {
  return OMS.computeFullState({
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: null, genesisAccounts: [], globalUsernames: {}, now: now,
  });
}

test("proposal auto-upvotes on propose and promotes immediately in a tiny population", async () => {
  nextTxId = 1;
  const pid = proposalId(USER_A);
  const txs = [tx(USER_A, "join", null, 0), propose(USER_A, 1000)];
  const state = await build(txs, 1700000000000 + 5000);
  const pr = state.PROPOSALS.get(pid);
  assert(pr, "proposal registered");
  assert(pr.upvoters.has(USER_A), "proposer auto-upvotes");
  assert(pr.promoted, "promotes immediately (1 active user, threshold 1)");
  // Promoted proposal surfaces as a live survey.
  assert(state.SURVEYS.some(s => s.id === pid), "promoted proposal becomes a survey");
  assert.strictEqual(state.openProposals.length, 0, "not in open proposals once promoted");
});

test("promotion respects the ceil(n/2) rounding boundary", async () => {
  nextTxId = 1;
  const pid = proposalId(USER_A);
  const D = "ut1zuserddddddddddddddddddddddddddddddddddddddddddddd1ddddd";
  const E = "ut1zuinteract4eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee1eeeee";
  // 5 active users → threshold = ceil(5/2) = 3. Two upvoters is NOT enough.
  const base = [
    tx(USER_A, "join", null, 0), tx(USER_B, "join", null, 100),
    tx(USER_C, "join", null, 200), tx(D, "join", null, 300), tx(E, "join", null, 400),
    propose(USER_A, 1000),           // upvoters {A} = 1
    upvote(USER_B, pid, 2000),       // upvoters {A,B} = 2  (< 3)
  ];
  const sTwo = await build(base, 1700000000000 + 5000);
  assert(!sTwo.PROPOSALS.get(pid).promoted, "2 of 5 upvotes does NOT promote (need 3)");

  const withThird = base.concat([upvote(USER_C, pid, 3000)]); // upvoters {A,B,C} = 3 ≥ 3
  const sThree = await build(withThird, 1700000000000 + 5000);
  assert(sThree.PROPOSALS.get(pid).promoted, "3 of 5 upvotes promotes");
});

test("double-upvote by the same user is deduped", async () => {
  nextTxId = 1;
  const pid = proposalId(USER_A);
  const D = "ut1zuserddddddddddddddddddddddddddddddddddddddddddddd1ddddd";
  const E = "ut1zuinteract5eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee1eeeee";
  // 5 active → threshold 3. A proposes (1). B upvotes twice (still 2). No promo.
  const txs = [
    tx(USER_A, "join", null, 0), tx(USER_B, "join", null, 100),
    tx(USER_C, "join", null, 200), tx(D, "join", null, 300), tx(E, "join", null, 400),
    propose(USER_A, 1000),
    upvote(USER_B, pid, 2000),
    upvote(USER_B, pid, 2500),   // duplicate — must not count twice
  ];
  const state = await build(txs, 1700000000000 + 5000);
  const pr = state.PROPOSALS.get(pid);
  assert.strictEqual(pr.upvoters.size, 2, "duplicate upvote deduped to 2 distinct upvoters");
  assert(!pr.promoted, "2 distinct upvoters < threshold 3 → not promoted");
});

test("promotion latches: later upvotes don't move promotedAtMs", async () => {
  nextTxId = 1;
  const pid = proposalId(USER_A);
  const D = "ut1zuserddddddddddddddddddddddddddddddddddddddddddddd1ddddd";
  const E = "ut1zuinteract6eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee1eeeee";
  const txs = [
    tx(USER_A, "join", null, 0), tx(USER_B, "join", null, 100),
    tx(USER_C, "join", null, 200), tx(D, "join", null, 300), tx(E, "join", null, 400),
    propose(USER_A, 1000),
    upvote(USER_B, pid, 2000),
    upvote(USER_C, pid, 3000),   // promotes here (3 of 5)
    upvote(D, pid, 9000),        // later upvote — must be a no-op
    upvote(E, pid, 9500),
  ];
  const state = await build(txs, 1700000000000 + 20000);
  const pr = state.PROPOSALS.get(pid);
  assert(pr.promoted, "promoted");
  assert.strictEqual(pr.promotedAtMs, 1700000000000 + 3000, "promotedAtMs latched at the decisive upvote");
});

test("per-user open-proposal cap of 3 is enforced", async () => {
  nextTxId = 1;
  const D = "ut1zuserddddddddddddddddddddddddddddddddddddddddddddd1ddddd";
  // 4 active users so a lone auto-upvote (1) < threshold ceil(4/2)=2 → proposals stay open.
  const titles = ["Q one", "Q two", "Q three", "Q four"];
  const txs = [
    tx(USER_A, "join", null, 0), tx(USER_B, "join", null, 100),
    tx(USER_C, "join", null, 200), tx(D, "join", null, 300),
  ];
  titles.forEach((title, i) => {
    txs.push(tx(USER_A, "propose_question", { proposal: { title, question: "Q?", options: PROP.options } }, 1000 + i * 100));
  });
  const state = await build(txs, 1700000000000 + 5000);
  const mine = state.openProposals.filter(p => p.proposedBy === USER_A);
  assert.strictEqual(mine.length, 3, "only 3 open proposals registered for USER_A (4th dropped by cap)");
});

test("expired proposals drop out and free up the cap", async () => {
  nextTxId = 1;
  const D = "ut1zuserddddddddddddddddddddddddddddddddddddddddddddd1ddddd";
  const txs = [
    tx(USER_A, "join", null, 0), tx(USER_B, "join", null, 100),
    tx(USER_C, "join", null, 200), tx(D, "join", null, 300),
    tx(USER_A, "propose_question", { proposal: { title: "Old Q", question: "Q?", options: PROP.options } }, 1000),
  ];
  // now is well past PROPOSAL_EXPIRY_MS after the proposal.
  const state = await build(txs, 1700000000000 + 1000 + OMS.PROPOSAL_EXPIRY_MS + 1);
  assert.strictEqual(state.openProposals.length, 0, "expired proposal excluded from openProposals");
});

test("promoted proposal seeds a market and settles like any survey", async () => {
  nextTxId = 1;
  const pid = proposalId(USER_A);
  // Single active user → promotes immediately; proposer is joined with 1000
  // credits so Phase 5b seeds the market from the 50-credit ante.
  const txs = [
    tx(USER_A, "join", null, 0),
    propose(USER_A, 1000),
    tx(USER_A, "vote", { survey: pid, choice: "yes" }, 2000),
  ];
  // now far enough in the future that the 7-day promoted survey has expired.
  const state = await build(txs, 1700000000000 + 1000 + OMS.DEFAULT_SURVEY_DURATION_MS + 60000);
  const survey = state.SURVEYS_BY_ID.get(pid);
  assert(survey, "promoted survey exists");
  assert(survey.archived, "promoted survey archived after its 7-day window");
  const mkt = state.MARKETS.get(pid);
  assert(mkt && Object.keys(mkt.pools).length === 2, "market seeded with both option pools");
  assert(state.SETTLEMENTS.has(pid), "promoted survey settled");
  // Proposer paid the 50-credit ante.
  assert.strictEqual(state.CREDIT_FLOWS.get(USER_A).antes, OMS.MARKET_ANTE, "creator ante charged");
});

test("activeUsersInWindow honors the 72h sliding window", () => {
  const ref = 1700000000000;
  const parsed = [
    { tx: { from: USER_A, ts: ref - 1000 }, memo: { type: "vote" } },           // in window
    { tx: { from: USER_B, ts: ref - OMS.PROPOSAL_ACTIVE_WINDOW_MS - 1 }, memo: { type: "join" } }, // too old
    { tx: { from: USER_C, ts: ref - 5000 }, memo: { type: "set_username" } },    // not an activity type
    { tx: { from: USER_A, ts: ref + 1000 }, memo: { type: "place_bet" } },       // future
  ];
  const active = OMS.activeUsersInWindow(parsed, ref);
  assert(active.has(USER_A), "recent voter counted");
  assert(!active.has(USER_B), "user outside 72h window excluded");
  assert(!active.has(USER_C), "set_username does not count as activity");
  assert.strictEqual(active.size, 1);
});

test("client and server agree on proposal promotion (shared module)", async () => {
  nextTxId = 1;
  const pid = proposalId(USER_A);
  const txs = [
    tx(USER_A, "join", null, 0), tx(USER_B, "join", null, 100), tx(USER_C, "join", null, 200),
    propose(USER_A, 1000), upvote(USER_B, pid, 2000),
  ];
  const opts = {
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: null, genesisAccounts: [], globalUsernames: {}, now: 1700000000000 + 5000,
  };
  const a = await OMS.computeFullState(opts);
  const b = await OMS.computeFullState(opts);
  assert.strictEqual(a.PROPOSALS.get(pid).promoted, b.PROPOSALS.get(pid).promoted);
  assert.strictEqual(a.openProposals.length, b.openProposals.length);
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

/* ── Daily BTC oracle settlement ──────────────────────────────────── */

const SERVER = "ut1zserverserverserverserverserverserverserverserver1srv";
const BASE = 1700000000000;
const BTC_DUR = 86400000;

function btcSurvey() {
  return {
    id: "btc-daily-test", title: "Daily BTC",
    question: "Will BTC be higher or lower than $68,000 by tomorrow?",
    options: [{ key: "higher", label: "Higher" }, { key: "lower", label: "Lower" }],
    active_duration_ms: BTC_DUR, reveal_interval_ms: null, allow_custom_options: false,
    kind: "btc_daily", strike_usd: 68000, priced_at: BASE,
  };
}

// Shared tx stream: server creates the question (NOT admin), a user joins
// and votes "higher". (Buy/sell trading was removed, so there is no bet in
// this stream anymore.) The oracle resolution is added per-test.
function btcStream() {
  nextTxId = 1;
  return [
    tx(SERVER, "create_daily_btc", { survey: btcSurvey() }, 0),
    tx(USER_A, "join", null, 1000),
    tx(USER_A, "vote", { survey: "btc-daily-test", choice: "higher" }, 1500),
  ];
}

test("BTC: server-authored question registers past the admin gate", async () => {
  const txs = btcStream();
  const state = await OMS.computeFullState({
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: ADMIN, genesisAccounts: [], globalUsernames: {}, now: BASE + 3000,
  });
  const sv = state.SURVEYS_BY_ID.get("btc-daily-test");
  assert(sv, "btc-daily survey registered despite non-admin sender");
  assert.strictEqual(sv.kind, "btc_daily");
  assert.strictEqual(sv.strikeUsd, 68000);
  assert.strictEqual(sv.createdBy, null, "BTC survey has no joined creator");
});

test("BTC: resolves to the oracle winner, not the vote majority", async () => {
  const txs = btcStream().concat([
    // Real price 69000 > strike 68000 → higher wins.
    tx(SERVER, "resolve_btc", {
      survey: "btc-daily-test", strike_usd: 68000, resolved_price_usd: 69000,
      resolved_at: BASE + 90000000, winner: "higher",
    }, 90000000),
  ]);
  const state = await OMS.computeFullState({
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: ADMIN, genesisAccounts: [], globalUsernames: {}, now: BASE + 90000001,
  });
  const settlement = state.SETTLEMENTS.get("btc-daily-test");
  assert(settlement, "settlement exists");
  assert.strictEqual(settlement.pending, undefined, "resolved, not pending");
  assert.strictEqual(settlement.btcWinner, "higher");
  assert.strictEqual(settlement.winner, "higher");
  assert.strictEqual(settlement.resolvedPriceUsd, 69000);
  // Trading removed: no one holds shares, so the resolved market pays no one.
  assert.strictEqual(Object.keys(settlement.payouts).length, 0, "no share holders to pay (trading removed)");
});

test("BTC: expired but unresolved stays pending and pays no one", async () => {
  const txs = btcStream(); // no resolve_btc memo
  const state = await OMS.computeFullState({
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: ADMIN, genesisAccounts: [], globalUsernames: {}, now: BASE + 90000000,
  });
  const sv = state.SURVEYS_BY_ID.get("btc-daily-test");
  assert(sv.archived, "survey is past expiry");
  const settlement = state.SETTLEMENTS.get("btc-daily-test");
  assert.strictEqual(settlement.pending, true, "pending — never settled by vote majority");
  assert.strictEqual(Object.keys(settlement.payouts).length, 0, "no payouts while unresolved");
  // USER_A voted "higher". With trading removed they never spend credits, so
  // their balance stays at the initial 1000 while the market is unresolved.
  assert.strictEqual(OMS.userBalance(state, USER_A), 1000, "no oracle payout yet");
});

test("BTC: push (price == strike) resolves with no winner", async () => {
  const txs = btcStream().concat([
    tx(SERVER, "resolve_btc", {
      survey: "btc-daily-test", strike_usd: 68000, resolved_price_usd: 68000,
      resolved_at: BASE + 90000000, winner: null,
    }, 90000000),
  ]);
  const state = await OMS.computeFullState({
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: ADMIN, genesisAccounts: [], globalUsernames: {}, now: BASE + 90000001,
  });
  const settlement = state.SETTLEMENTS.get("btc-daily-test");
  assert.strictEqual(settlement.btcWinner, null, "push has no winner");
  assert.strictEqual(settlement.pending, undefined, "resolved, not pending");
  // Trading removed: a push would refund share holders, but there are none.
  assert.strictEqual(Object.keys(settlement.payouts).length, 0, "no share holders to refund (trading removed)");
});

test("BTC: replay is deterministic (client == server) under duplicate memos", async () => {
  // Two `resolve_btc` memos with marginally different prices (parallel
  // deploys). Earliest-memo-wins must make both rebuilds identical.
  const txs = btcStream().concat([
    tx(SERVER, "resolve_btc", {
      survey: "btc-daily-test", strike_usd: 68000, resolved_price_usd: 69000,
      resolved_at: BASE + 90000000, winner: "higher",
    }, 90000000),
    tx(SERVER, "resolve_btc", {
      survey: "btc-daily-test", strike_usd: 68000, resolved_price_usd: 70000,
      resolved_at: BASE + 90000500, winner: "higher",
    }, 90000500),
  ]);
  const opts = {
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: ADMIN, genesisAccounts: [], globalUsernames: {}, now: BASE + 90001000,
  };
  const a = await OMS.computeFullState(opts);
  const b = await OMS.computeFullState(opts);
  const sa = a.SETTLEMENTS.get("btc-daily-test");
  const sb = b.SETTLEMENTS.get("btc-daily-test");
  assert.strictEqual(sa.resolvedPriceUsd, 69000, "earliest resolution wins");
  assert.strictEqual(sa.resolvedPriceUsd, sb.resolvedPriceUsd);
  assert.strictEqual(sa.payouts[USER_A], sb.payouts[USER_A]);
});

/* ── World Cup 2026 match markets ─────────────────────────────────── */

const WC_KICKOFF = BASE + 50000000;
function wcMatchMemo() {
  return {
    id: "wc26-GRP-A-1", matchId: "wc26-GRP-A-1",
    title: "Mexico vs South Africa",
    question: "Mexico vs South Africa — home win, draw, or away win?",
    options: [
      { key: "home_win", label: "Home win" },
      { key: "draw", label: "Draw" },
      { key: "away_win", label: "Away win" },
    ],
    kind: "wc26_match", stage: "group", group: "A",
    home_team: "MEX", away_team: "RSA",
    home_team_name: "Mexico", away_team_name: "South Africa",
    kickoff_ms: WC_KICKOFF, venue: "Mexico City (Estadio Azteca)",
    // active_duration_ms = kickoff - createdAt + 8h. createdAt here = BASE+0.
    active_duration_ms: (WC_KICKOFF - BASE) + 8 * 3600000,
    reveal_interval_ms: null,
  };
}
// Server creates the match (non-admin), USER_A bets home_win, USER_B bets away_win.
function wcStream() {
  nextTxId = 1;
  return [
    tx(SERVER, "create_wc26_match", { match: wcMatchMemo() }, 0),
    tx(USER_A, "join", null, 1000),
    tx(USER_B, "join", null, 1100),
    tx(USER_A, "place_bet", { survey: "wc26-GRP-A-1", option: "home_win", credits: 100, side: "yes" }, 2000),
    tx(USER_B, "place_bet", { survey: "wc26-GRP-A-1", option: "away_win", credits: 100, side: "yes" }, 2500),
  ];
}

test("WC26: server-authored match registers past the admin gate with wc26 fields", async () => {
  const txs = wcStream();
  const state = await OMS.computeFullState({
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: ADMIN, genesisAccounts: [], globalUsernames: {}, now: BASE + 3000,
  });
  const sv = state.SURVEYS_BY_ID.get("wc26-GRP-A-1");
  assert(sv, "wc26 match survey registered despite non-admin sender");
  assert.strictEqual(sv.kind, "wc26_match");
  assert.strictEqual(sv.createdBy, null, "wc26 survey has no joined creator");
  assert(sv.wc26, "carries wc26 sub-object");
  assert.strictEqual(sv.wc26.kickoffMs, WC_KICKOFF);
  assert.strictEqual(sv.wc26.group, "A");
  assert.strictEqual(sv.wc26.homeTeam, "MEX");
  // expiresAtMs = createdAtMs + activeDurationMs, NOT clamped to an allowed
  // duration (the variable kickoff-relative window is trusted verbatim).
  assert.strictEqual(sv.expiresAtMs, sv.createdAtMs + ((WC_KICKOFF - BASE) + 8 * 3600000), "expires at kickoff+8h window");
});

test("WC26: bet at/after kickoff is rejected MATCH_LOCKED", async () => {
  const txs = wcStream().concat([
    tx(USER_A, "place_bet", { survey: "wc26-GRP-A-1", option: "home_win", credits: 50, side: "yes" }, (WC_KICKOFF - BASE) + 60000),
  ]);
  const state = await OMS.computeFullState({
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: ADMIN, genesisAccounts: [], globalUsernames: {}, now: WC_KICKOFF + 9 * 3600000,
  });
  const locked = state.rejectedSends.filter((r) => r.reason === "MATCH_LOCKED");
  assert.strictEqual(locked.length, 1, "exactly one MATCH_LOCKED rejection");
});

test("WC26: resolves to the oracle winner, paying winning-option holders", async () => {
  const txs = wcStream().concat([
    tx(SERVER, "resolve_wc26_match", {
      matchId: "wc26-GRP-A-1", winnerKey: "home_win", source: "football-data-api",
      resolved_at: WC_KICKOFF + 2 * 3600000,
    }, (WC_KICKOFF - BASE) + 2 * 3600000),
  ]);
  const state = await OMS.computeFullState({
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: ADMIN, genesisAccounts: [], globalUsernames: {}, now: WC_KICKOFF + 9 * 3600000,
  });
  const settlement = state.SETTLEMENTS.get("wc26-GRP-A-1");
  assert.strictEqual(settlement.kind, "wc26_match");
  assert.strictEqual(settlement.winner, "home_win", "oracle winner, not vote majority");
  assert(settlement.payouts[USER_A] > 0, "home_win backer paid");
  assert(!settlement.payouts[USER_B], "away_win backer gets nothing");
  assert(OMS.userBalance(state, USER_A) > 1000, "winner ends up ahead");
});

test("WC26: void resolution refunds all share holders", async () => {
  const txs = wcStream().concat([
    tx(SERVER, "resolve_wc26_match", {
      matchId: "wc26-GRP-A-1", winnerKey: "void", source: "football-data-api",
      resolved_at: WC_KICKOFF + 2 * 3600000,
    }, (WC_KICKOFF - BASE) + 2 * 3600000),
  ]);
  const state = await OMS.computeFullState({
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: ADMIN, genesisAccounts: [], globalUsernames: {}, now: WC_KICKOFF + 9 * 3600000,
  });
  const settlement = state.SETTLEMENTS.get("wc26-GRP-A-1");
  assert.strictEqual(settlement.wcWinner, "void");
  assert(settlement.payouts[USER_A] > 0, "void refunds USER_A");
  assert(settlement.payouts[USER_B] > 0, "void refunds USER_B");
});

test("WC26: expired but unresolved stays pending and pays no one", async () => {
  const txs = wcStream(); // no resolve memo
  const state = await OMS.computeFullState({
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: ADMIN, genesisAccounts: [], globalUsernames: {}, now: WC_KICKOFF + 9 * 3600000,
  });
  const sv = state.SURVEYS_BY_ID.get("wc26-GRP-A-1");
  assert(sv.archived, "past kickoff+8h expiry");
  const settlement = state.SETTLEMENTS.get("wc26-GRP-A-1");
  assert.strictEqual(settlement.pending, true, "pending with no resolution");
  assert.strictEqual(Object.keys(settlement.payouts).length, 0, "no payouts while unresolved");
});

test("WC26: validatePlaceBet mirrors the MATCH_LOCKED rule against local clock", async () => {
  const txs = wcStream();
  const state = await OMS.computeFullState({
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: ADMIN, genesisAccounts: [], globalUsernames: {}, now: WC_KICKOFF - 3600000,
  });
  const before = OMS.validatePlaceBet(state, { pubkey: USER_A, surveyId: "wc26-GRP-A-1", optionKey: "home_win", credits: 10, now: WC_KICKOFF - 1000 });
  const after = OMS.validatePlaceBet(state, { pubkey: USER_A, surveyId: "wc26-GRP-A-1", optionKey: "home_win", credits: 10, now: WC_KICKOFF + 1000 });
  assert.strictEqual(before.ok, true, "bet allowed before kickoff");
  assert.strictEqual(after.ok, false, "bet blocked after kickoff");
  assert.strictEqual(after.reason, "MATCH_LOCKED");
});

test("WC26: replay deterministic under duplicate create+resolve memos", async () => {
  const txs = wcStream().concat([
    tx(SERVER, "create_wc26_match", { match: wcMatchMemo() }, 500),
    tx(SERVER, "resolve_wc26_match", { matchId: "wc26-GRP-A-1", winnerKey: "home_win", resolved_at: WC_KICKOFF + 2 * 3600000 }, (WC_KICKOFF - BASE) + 2 * 3600000),
    tx(SERVER, "resolve_wc26_match", { matchId: "wc26-GRP-A-1", winnerKey: "home_win", resolved_at: WC_KICKOFF + 3 * 3600000 }, (WC_KICKOFF - BASE) + 3 * 3600000),
  ]);
  const opts = {
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: ADMIN, genesisAccounts: [], globalUsernames: {}, now: WC_KICKOFF + 9 * 3600000,
  };
  const a = await OMS.computeFullState(opts);
  const b = await OMS.computeFullState(opts);
  const sa = a.SETTLEMENTS.get("wc26-GRP-A-1");
  const sb = b.SETTLEMENTS.get("wc26-GRP-A-1");
  assert.strictEqual(sa.winner, "home_win");
  assert.strictEqual(sa.payouts[USER_A], sb.payouts[USER_A], "deterministic payout");
});

/* ── #33: binary (Yes/No) authoring + multi-option backward compat ──── */

test("#33: a binary Yes/No survey seeds a two-pool market and settles", async () => {
  // Mirrors what the client create form now always emits (#33): exactly two
  // fixed options with custom options disabled. The market must seed two
  // pools, the winning YES bet must pay out, and the survey must settle.
  nextTxId = 1;
  const survey = {
    id: "bin1", title: "T", question: "Q?",
    options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }],
    active_duration_ms: 60000, allow_custom_options: false,
  };
  const txs = [
    tx(ADMIN, "join", null, 0),
    tx(USER_A, "join", null, 1000),
    tx(ADMIN, "create_survey", { survey }, 2000),
    tx(USER_A, "place_bet", { survey: "bin1", option: "yes", credits: 100, side: "yes" }, 3000),
    tx(USER_A, "vote", { survey: "bin1", choice: "yes" }, 4000),
  ];
  const state = await OMS.computeFullState({
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: ADMIN, genesisAccounts: [], globalUsernames: {},
    now: 1700000000000 + 120000, // past the 60s window → expired + settled
  });
  const sv = state.SURVEYS_BY_ID.get("bin1");
  assert(sv, "binary survey exists");
  assert.deepStrictEqual(sv.options.map(o => o.key), ["yes", "no"], "exactly the two fixed options");
  const mkt = state.MARKETS.get("bin1");
  assert(mkt && Object.keys(mkt.pools).length === 2, "market seeded with exactly two pools");
  assert(state.SETTLEMENTS.has("bin1"), "binary survey settled");
  assert(state.CREDIT_FLOWS.get(USER_A).payouts > 0, "winning YES bet paid out");
});

test("#33 regression: legacy multi-option surveys (3 base + add_option) still replay", async () => {
  // The authoring restriction is client-side only; the replay engine stays
  // generic over N outcomes so historical surveys — and any custom options
  // already added on-chain via add_option — keep seeding pools and settling.
  // If Phase 4's add_option merge or the N-outcome market math regressed,
  // this fails.
  nextTxId = 1;
  const survey = {
    id: "multi1", title: "T", question: "Q?",
    options: [
      { key: "red", label: "Red" },
      { key: "green", label: "Green" },
      { key: "blue", label: "Blue" },
    ],
    active_duration_ms: 60000, allow_custom_options: true,
  };
  const txs = [
    tx(ADMIN, "join", null, 0),
    tx(USER_A, "join", null, 1000),
    tx(ADMIN, "create_survey", { survey }, 2000),
    tx(USER_A, "add_option", { survey: "multi1", option: { key: "yellow", label: "Yellow" } }, 2500),
    tx(USER_A, "place_bet", { survey: "multi1", option: "red", credits: 100, side: "yes" }, 3000),
    tx(USER_A, "vote", { survey: "multi1", choice: "red" }, 4000),
  ];
  const state = await OMS.computeFullState({
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: ADMIN, genesisAccounts: [], globalUsernames: {},
    now: 1700000000000 + 120000,
  });
  const sv = state.SURVEYS_BY_ID.get("multi1");
  assert(sv, "legacy multi-option survey exists");
  assert.strictEqual(sv.options.length, 4, "3 base options + 1 custom option preserved");
  assert(sv.options.some(o => o.key === "yellow"), "add_option merged (Phase 4 intact)");
  const mkt = state.MARKETS.get("multi1");
  assert(mkt && Object.keys(mkt.pools).length === 4, "market seeded with all four option pools");
  assert(state.SETTLEMENTS.has("multi1"), "multi-option survey settles");
  assert(state.CREDIT_FLOWS.get(USER_A).payouts > 0, "winning bet on a multi-option market paid out");
});

/* ── computeMarketAnalytics (detail-view Analytics panel) ──────────── */

// Helper: build a state + survey + market for an active binary survey with
// some votes and bets, then derive analytics from it.
async function analyticsFixture(now) {
  nextTxId = 1;
  const survey = {
    id: "anly1", title: "T", question: "Q?",
    options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }],
    active_duration_ms: 30 * 86400000,
  };
  const base = 1700000000000;
  // NOTE: tx()'s 4th arg is a RELATIVE offset; it adds `base` internally.
  const txs = [
    tx(ADMIN, "join", null, 0),
    tx(USER_A, "join", null, 1000),
    tx(USER_B, "join", null, 2000),
    tx(USER_C, "join", null, 3000),
    tx(ADMIN, "create_survey", { survey }, 4000),
    // Votes (plaintext choice passes through decryptVoteMemos) spaced in time.
    tx(USER_A, "vote", { survey: "anly1", choice: "yes" }, 10000),
    tx(USER_B, "vote", { survey: "anly1", choice: "no" }, 20000),
    tx(USER_C, "vote", { survey: "anly1", choice: "yes" }, 30000),
    // Bets pushing the "yes" option's implied prob up over time.
    tx(USER_A, "place_bet", { survey: "anly1", option: "yes", side: "yes", credits: 50 }, 11000),
    tx(USER_B, "place_bet", { survey: "anly1", option: "yes", side: "yes", credits: 80 }, 25000),
  ];
  const state = await OMS.computeFullState({
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: ADMIN, genesisAccounts: [], globalUsernames: {},
    now: now,
  });
  return { state, survey: state.SURVEYS_BY_ID.get("anly1"), rawTxs: txs, base };
}

test("computeMarketAnalytics: participant union counts voters + bettors", async () => {
  const now = 1700000000000 + 40000;
  const { state, survey, rawTxs } = await analyticsFixture(now);
  const a = OMS.computeMarketAnalytics(survey, state.MARKETS.get("anly1"), rawTxs, null, { appPubkey: APP_PUBKEY, now });
  // Voters: A, B, C. Bettors: A, B. Union = {A,B,C} = 3.
  assert.strictEqual(a.voterCount, 3, "three distinct voters");
  assert.strictEqual(a.bettorCount, 2, "two distinct bettors");
  assert.strictEqual(a.participants, 3, "participant union dedups A/B who both voted and bet");
});

test("computeMarketAnalytics: vote trend is a cumulative, time-ordered curve", async () => {
  const now = 1700000000000 + 40000;
  const { state, survey, rawTxs } = await analyticsFixture(now);
  const a = OMS.computeMarketAnalytics(survey, state.MARKETS.get("anly1"), rawTxs, null, { appPubkey: APP_PUBKEY, now });
  assert.strictEqual(a.voteTrend.length, 3, "one point per distinct voter");
  assert.deepStrictEqual(a.voteTrend.map(p => p.count), [1, 2, 3], "monotonically increasing count");
  for (let i = 1; i < a.voteTrend.length; i++) {
    assert(a.voteTrend[i].ts >= a.voteTrend[i - 1].ts, "timestamps non-decreasing");
  }
});

test("computeMarketAnalytics: momentum reports an upward move on the rising leader", async () => {
  const now = 1700000000000 + 40000;
  const { state, survey, rawTxs } = await analyticsFixture(now);
  // Window large enough to span both bets so the past reference predates them.
  const a = OMS.computeMarketAnalytics(survey, state.MARKETS.get("anly1"), rawTxs, null, { appPubkey: APP_PUBKEY, now, momentumWindowMs: 60000 });
  assert(a.momentum.available, "momentum available with >= 2 history points");
  assert.strictEqual(a.momentum.leaderKey, "yes", "yes is leading after the yes-side bets");
  assert(a.momentum.deltaPts > 0, "leader probability rose over the window");
  assert.strictEqual(a.momentum.label, "heating", "rising leader reads as heating up");
});

test("computeMarketAnalytics: split is market-implied while active", async () => {
  const now = 1700000000000 + 40000;
  const { state, survey, rawTxs } = await analyticsFixture(now);
  const a = OMS.computeMarketAnalytics(survey, state.MARKETS.get("anly1"), rawTxs, null, { appPubkey: APP_PUBKEY, now });
  assert.strictEqual(a.split.source, "market", "active survey uses market-implied split");
  assert(a.split.hasData, "split has data once the market has liquidity");
  const yes = a.split.entries.find(e => e.key === "yes");
  const no = a.split.entries.find(e => e.key === "no");
  assert(yes && no, "both sides present");
  assert(yes.pct > no.pct, "yes leads after yes-side bets");
  assert(Math.abs((yes.pct + no.pct) - 1) < 0.02, "binary split sums to ~1");
});

test("computeMarketAnalytics: split switches to final vote tally once settled", async () => {
  // Short survey so it archives; oracle-free binary settles on the vote map.
  nextTxId = 1;
  const survey = {
    id: "anly2", title: "T", question: "Q?",
    options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }],
    active_duration_ms: 60000,
  };
  const base = 1700000000000;
  // NOTE: tx()'s 4th arg is a RELATIVE offset; it adds `base` internally.
  const txs = [
    tx(ADMIN, "join", null, 0),
    tx(USER_A, "join", null, 1000),
    tx(USER_B, "join", null, 2000),
    tx(USER_C, "join", null, 3000),
    tx(ADMIN, "create_survey", { survey }, 4000),
    tx(USER_A, "vote", { survey: "anly2", choice: "yes" }, 10000),
    tx(USER_B, "vote", { survey: "anly2", choice: "yes" }, 11000),
    tx(USER_C, "vote", { survey: "anly2", choice: "no" }, 12000),
  ];
  const now = base + 5 * 60000; // well past the 60s active window
  const state = await OMS.computeFullState({
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: ADMIN, genesisAccounts: [], globalUsernames: {},
    now: now,
  });
  const sv = state.SURVEYS_BY_ID.get("anly2");
  assert(sv.archived, "survey archived after active window");
  const a = OMS.computeMarketAnalytics(sv, state.MARKETS.get("anly2"), txs, state.SETTLEMENTS.get("anly2"), { appPubkey: APP_PUBKEY, now });
  assert.strictEqual(a.split.source, "votes", "settled survey uses final vote tally");
  const yes = a.split.entries.find(e => e.key === "yes");
  const no = a.split.entries.find(e => e.key === "no");
  assert.strictEqual(yes.count, 2, "two yes votes");
  assert.strictEqual(no.count, 1, "one no vote");
  assert(Math.abs(yes.pct - 2 / 3) < 0.001, "yes share = 2/3");
  // Momentum is hidden for archived markets.
  assert.strictEqual(a.momentum.available, false, "no momentum once archived");
});

run();
