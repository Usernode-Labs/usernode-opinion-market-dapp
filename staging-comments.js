// staging-comments.js — staging-only seeder for per-market discussion.
//
// Issue #30 adds a flat public comment thread (`comment` memos) to every
// market. A fresh staging preview has no comments, so the Discussion section
// would only ever show its empty state. This module injects a handful of
// obviously-fake comments from 3 fake authors onto ONE of the staging demo
// polls (staging-polls.js), leaving the others empty so reviewers can compare
// the populated thread against the empty state. Same injection path as the
// other staging seeders: the `seedTransaction` hook writes straight into the
// cache's raw-tx feed. A strict no-op when `seedTransaction` is null (server.js
// only passes one for USERNODE_ENV=staging, or --local-dev mock mode).
//
// Seeded authors are fake identities, never the visitor, and comments carry no
// signal any other code path reads (they are not an ACTIVITY_TYPE and move no
// balances), so seeding them cannot fabricate a production-different answer.

const APP_ID = "opinion-market";
const SEED_INTERVAL_MS = 2 * 60 * 1000;

// The poll the thread is seeded on (see staging-polls.js DEMO_POLLS).
const TARGET_SURVEY_ID = "staging-demo-hotdog";

const AUTHORS = {
  ana: { pubkey: "ut1stagingdemoanaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", username: "demo_ana" },
  ben: { pubkey: "ut1stagingdemobenbbbbbbbbbbbbbbbbbbbbbbbbbbbb", username: "demo_ben" },
  // No set_username on purpose: renders as the default user_xxxxxx name.
  cal: { pubkey: "ut1stagingdemocalccccccccccccccccccccccccccccc", username: null },
};

// Fixed ids keep re-seeding idempotent. agoMs spreads the relative timestamps.
const DEMO_COMMENTS = [
  { id: "staging-seed-comment-1", author: "ana", agoMs: 26 * 3600e3, text: "Staging demo: A sandwich needs two separate slices of bread. Voting No." },
  { id: "staging-seed-comment-2", author: "ben", agoMs: 20 * 3600e3, text: "Staging demo: The bun is one piece hinged on one side, just like a sub roll. That is a sandwich." },
  { id: "staging-seed-comment-3", author: "cal", agoMs: 5 * 3600e3, text: "Staging demo: The odds moved a lot after the last bet. Curious where this settles." },
  { id: "staging-seed-comment-4", author: "ana", agoMs: 90 * 60e3, text: "Staging demo: Fair point on sub rolls, but nobody orders a hot dog at a sandwich shop." },
  { id: "staging-seed-comment-5", author: "ben", agoMs: 8 * 60e3, text: "Staging demo: Placed a small bet on Yes. Let us see." },
];

function parseExisting(getRawTransactions, appPubkey) {
  const txIds = new Set();
  const surveyIds = new Set();
  const named = new Set();
  const txs = (getRawTransactions && getRawTransactions()) || [];
  for (const tx of txs) {
    const to = tx.destination_pubkey || tx.to || tx.destination;
    if (to !== appPubkey) continue;
    const id = tx.tx_id || tx.id;
    if (id) txIds.add(String(id));
    let memo;
    try { memo = typeof tx.memo === "string" ? JSON.parse(tx.memo) : tx.memo; }
    catch (_) { continue; }
    if (!memo || memo.app !== APP_ID) continue;
    if (memo.type === "create_survey" && memo.survey && memo.survey.id) surveyIds.add(memo.survey.id);
    if (memo.type === "set_username") named.add(tx.from_pubkey || tx.from || tx.source);
  }
  return { txIds, surveyIds, named };
}

function createStagingComments(opts) {
  const appPubkey = opts.appPubkey;
  const getRawTransactions = opts.getRawTransactions;
  const seedTransaction = typeof opts.seedTransaction === "function" ? opts.seedTransaction : null;
  const nowFn = opts.now || Date.now;
  let seedTimer = null;

  function injectTx(id, from, memo, ts) {
    seedTransaction({
      tx_id: id,
      id,
      from_pubkey: from,
      destination_pubkey: appPubkey,
      amount: 1,
      memo: JSON.stringify(memo),
      created_at: new Date(ts).toISOString(),
    });
  }

  function seedStaging() {
    if (!seedTransaction) return 0;
    const now = nowFn();
    let existing;
    try { existing = parseExisting(getRawTransactions, appPubkey); }
    catch (_) { return 0; }
    // Wait for staging-polls.js to create the target poll; retried next tick.
    if (!existing.surveyIds.has(TARGET_SURVEY_ID)) return 0;

    let injected = 0;
    for (const key of Object.keys(AUTHORS)) {
      const a = AUTHORS[key];
      if (!a.username || existing.named.has(a.pubkey)) continue;
      const id = "staging-seed-username-" + key;
      if (existing.txIds.has(id)) continue;
      try {
        injectTx(id, a.pubkey, { app: APP_ID, type: "set_username", username: a.username }, now - 30 * 3600e3);
      } catch (e) { console.error(`[staging-comments] username seed error: ${e.message}`); }
    }
    for (const c of DEMO_COMMENTS) {
      if (existing.txIds.has(c.id)) continue;
      try {
        injectTx(c.id, AUTHORS[c.author].pubkey,
          { app: APP_ID, type: "comment", survey: TARGET_SURVEY_ID, text: c.text }, now - c.agoMs);
        injected++;
      } catch (e) { console.error(`[staging-comments] seed error (${c.id}): ${e.message}`); }
    }
    if (injected > 0) console.log(`[staging-comments] seeded ${injected} demo comment(s) on ${TARGET_SURVEY_ID}`);
    return injected;
  }

  function safeSeed() {
    try { return seedStaging(); }
    catch (e) { console.error(`[staging-comments] seed error: ${e.message}`); return 0; }
  }

  function start() {
    if (!seedTransaction) return; // production: nothing to do
    // Run after staging-polls.js's 3s warmup so the target poll exists.
    const warmup = setTimeout(safeSeed, 5000);
    if (warmup.unref) warmup.unref();
    seedTimer = setInterval(safeSeed, SEED_INTERVAL_MS);
    if (seedTimer.unref) seedTimer.unref();
  }

  function stop() { if (seedTimer) clearInterval(seedTimer); }

  return { start, stop, seedStaging: safeSeed };
}

module.exports = createStagingComments;
module.exports.TARGET_SURVEY_ID = TARGET_SURVEY_ID;
module.exports.DEMO_COMMENTS = DEMO_COMMENTS;
