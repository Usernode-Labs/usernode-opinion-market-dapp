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

// Buy/sell trading was removed from the app: the state engine no longer
// processes `place_bet` / `sell_shares` memos, so the former Phase-6 trade
// tests (balance-cap rejection, MAX_BET_POOL_RATIO cap, validatePlaceBet
// preflight) no longer apply and have been deleted.

test("trading removed: place_bet / sell_shares memos are ignored by the engine", async () => {
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
    // These trade memos must be no-ops now — no shares, no balance change.
    tx(USER_A, "place_bet", { survey: "s1", option: "yes", credits: 100, side: "yes" }, 3000),
    tx(USER_A, "sell_shares", { survey: "s1", option: "yes", shares: 5, side: "yes" }, 4000),
  ];
  const state = await OMS.computeFullState({
    rawTxs: txs, decryptedTxs: txs, appPubkey: APP_PUBKEY,
    adminPubkey: ADMIN, genesisAccounts: [], globalUsernames: {},
    now: 1700000010000,
  });
  const flow = state.CREDIT_FLOWS.get(USER_A);
  assert(flow, "USER_A has a flow entry");
  assert.strictEqual(flow.grossBets, 0, "no bets are processed");
  assert.strictEqual(flow.netSells, 0, "no sells are processed");
  // Balance untouched by the ignored trade memos.
  assert.strictEqual(OMS.userBalance(state, USER_A), OMS.INITIAL_CREDITS, "balance unchanged by ignored trades");
  // No shares accrued anywhere.
  const mkt = state.MARKETS.get("s1");
  assert(mkt, "market still seeded for the survey");
  assert.strictEqual(Object.keys(mkt.userShares).length, 0, "no YES share holders");
  assert.strictEqual(Object.keys(mkt.userNoShares).length, 0, "no NO share holders");
  // validatePlaceBet was removed alongside the trade flow.
  assert.strictEqual(typeof OMS.validatePlaceBet, "undefined", "validatePlaceBet export removed");
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

// The BUG-INLINE-SETTLEMENT and interleaved-settlement regression tests
// exercised the interaction between trades and settlements (a bet placed
// after an earlier survey settled). With buy/sell trading removed there are
// no trades to interleave, so both tests were deleted along with the
// trade-processing code path they guarded.

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

run();
