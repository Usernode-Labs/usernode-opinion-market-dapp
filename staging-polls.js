// staging-polls.js — staging-only seeder for binary (Yes/No) opinion polls.
//
// Issue #33 locks every newly-created poll to a fixed two-outcome Yes/No
// format. The staging preview needs a few such polls present so the survey
// list, the two-row trading UI, and the vote sheet can be exercised without
// hand-crafting transactions. This module injects 2-3 `create_survey` memos
// straight into the cache's raw-tx feed (the same feed
// /opinion-market/api/transactions and opinion-market-state.js read) via the
// `seedTransaction` hook — exactly the pattern daily-btc.js / world-cup-2026.js
// use. It is a strict no-op in production: server.js only passes a
// `seedTransaction` when USERNODE_ENV === "staging".
//
// Gating note: a plain `create_survey` only survives Phase 3 replay when its
// sender is the effective admin (ADMIN_PUBKEY env, else the first account to
// `join`). So the seeds are sent from that effective admin, and a `join` from
// the same sender is injected first — in an empty staging cache this makes the
// sender the first joiner (hence admin); when a real admin already exists the
// join is a harmless idempotent no-op.

const APP_ID = "opinion-market";

const SEED_INTERVAL_MS = 2 * 60 * 1000; // re-seed cadence (survives a cache reset)
const POLL_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — stays active in the preview

// Deterministic fake sender used only when there is no ADMIN_PUBKEY and no
// existing joiner in the cache (a cold/empty staging cache). Obviously fake.
const STAGING_DEMO_SENDER = "ut1stagingdemoadmin000000000000000000000000";

// The binary polls to seed. Fixed ids keep re-seeding idempotent. Options are
// always the binary Yes/No pair with custom options disabled (#33).
const DEMO_POLLS = [
  {
    id: "staging-demo-rain",
    title: "Staging demo: Rain tomorrow",
    question: "Will it rain in the city tomorrow?",
  },
  {
    id: "staging-demo-hotdog",
    title: "Staging demo: Hot dog",
    question: "Is a hot dog a sandwich?",
  },
  {
    id: "staging-demo-btc-week",
    title: "Staging demo: BTC this week",
    question: "Will BTC close higher at the end of the week?",
  },
];

const BINARY_OPTIONS = [
  { key: "yes", label: "Yes" },
  { key: "no", label: "No" },
];

function txTimestampMs(tx) {
  if (typeof tx.timestamp_ms === "number") return tx.timestamp_ms;
  if (typeof tx.created_at === "number") return tx.created_at;
  if (typeof tx.created_at === "string") {
    const t = Date.parse(tx.created_at);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

// Scan the raw-tx feed for the state this seeder cares about: which survey ids
// already exist, the set of joined senders, and the earliest joiner (the
// replay's admin when no ADMIN_PUBKEY is configured). Pure read.
function parseExisting(getRawTransactions, appPubkey) {
  const createdIds = new Set();
  const joined = new Set();
  let firstJoiner = null;
  let firstJoinTs = Infinity;
  const txs = (getRawTransactions && getRawTransactions()) || [];
  for (const tx of txs) {
    const to = tx.destination_pubkey || tx.to || tx.destination;
    if (to !== appPubkey) continue;
    let memo;
    try { memo = typeof tx.memo === "string" ? JSON.parse(tx.memo) : tx.memo; }
    catch (_) { continue; }
    if (!memo || memo.app !== APP_ID) continue;
    const from = tx.from_pubkey || tx.from || tx.source;
    if (memo.type === "create_survey" && memo.survey && memo.survey.id) {
      createdIds.add(memo.survey.id);
    } else if (memo.type === "join" && from) {
      joined.add(from);
      const ts = txTimestampMs(tx);
      if (ts != null && ts < firstJoinTs) { firstJoinTs = ts; firstJoiner = from; }
    }
  }
  return { createdIds, joined, firstJoiner };
}

function buildJoinMemo() {
  return { app: APP_ID, type: "join" };
}

function buildCreateMemo(poll) {
  return {
    app: APP_ID,
    type: "create_survey",
    survey: {
      id: poll.id,
      title: poll.title,
      question: poll.question,
      options: BINARY_OPTIONS.map(o => ({ key: o.key, label: o.label })),
      active_duration_ms: POLL_DURATION_MS,
      reveal_interval_ms: null,
      allow_custom_options: false,
    },
  };
}

function createStagingPolls(opts) {
  const appPubkey = opts.appPubkey;
  const adminPubkey = opts.adminPubkey || null;
  const getRawTransactions = opts.getRawTransactions;
  const seedTransaction = typeof opts.seedTransaction === "function" ? opts.seedTransaction : null;
  const nowFn = opts.now || Date.now;
  let seedTimer = null;
  let stopped = false;

  const status = { startedAt: null, lastSeedAt: null, lastSeedCount: 0, lastError: null };

  function injectTx(memo, seedTxId, from, now) {
    const tx = {
      tx_id: seedTxId,
      id: seedTxId,
      from_pubkey: from,
      destination_pubkey: appPubkey,
      amount: 1,
      memo: JSON.stringify(memo),
      created_at: new Date(now).toISOString(),
    };
    seedTransaction(tx);
  }

  async function seedStaging() {
    if (!seedTransaction) return getStatus();
    const now = nowFn();
    let existing;
    try { existing = parseExisting(getRawTransactions, appPubkey); }
    catch (_) { existing = { createdIds: new Set(), joined: new Set(), firstJoiner: null }; }

    // Effective admin: ADMIN_PUBKEY wins (it overrides firstJoiner in replay),
    // else the existing first joiner, else our fake demo sender.
    const sender = adminPubkey || existing.firstJoiner || STAGING_DEMO_SENDER;

    // Ensure the sender is joined so it can be the firstJoiner/admin in an
    // empty cache (and so the surveys have a valid creator). Idempotent.
    if (!existing.joined.has(sender)) {
      try { injectTx(buildJoinMemo(), "staging-seed-join-" + sender.slice(-8), sender, now); }
      catch (e) { console.error(`[staging-polls] join seed error: ${e.message}`); }
    }

    let injected = 0;
    for (const poll of DEMO_POLLS) {
      if (existing.createdIds.has(poll.id)) continue;
      try {
        injectTx(buildCreateMemo(poll), "staging-seed-" + poll.id, sender, now);
        injected++;
      } catch (e) {
        status.lastError = `seed ${poll.id}: ${e.message}`;
        console.error(`[staging-polls] seed error (${poll.id}): ${e.message}`);
      }
    }
    if (injected > 0) {
      status.lastSeedAt = now;
      status.lastSeedCount = injected;
      status.lastError = null;
      console.log(`[staging-polls] staging-seeded ${injected} binary Yes/No poll(s) from ${sender.slice(0, 12)}…`);
    }
    return getStatus();
  }

  function safeSeedStaging() {
    return seedStaging().catch((e) => {
      console.error(`[staging-polls] staging seed error: ${e.message}`);
      return getStatus();
    });
  }

  function getStatus() {
    return {
      pollIds: DEMO_POLLS.map(p => p.id),
      startedAt: status.startedAt,
      lastSeedAt: status.lastSeedAt,
      lastSeedCount: status.lastSeedCount,
      lastError: status.lastError,
    };
  }

  function start() {
    status.startedAt = nowFn();
    if (!seedTransaction) return; // production / non-staging: nothing to do
    // Let the chain poller warm the raw-tx cache first so idempotency checks
    // see existing state, then re-seed periodically to survive a cache reset.
    const warmup = setTimeout(() => safeSeedStaging(), 3000);
    if (warmup.unref) warmup.unref();
    seedTimer = setInterval(() => safeSeedStaging(), SEED_INTERVAL_MS);
    if (seedTimer.unref) seedTimer.unref();
    console.log("[staging-polls] staging seed enabled (re-seed every " + Math.round(SEED_INTERVAL_MS / 60000) + "m)");
  }

  function stop() {
    stopped = true;
    if (seedTimer) clearInterval(seedTimer);
  }

  return { start, stop, seedStaging: safeSeedStaging, getStatus };
}

module.exports = createStagingPolls;
module.exports.DEMO_POLLS = DEMO_POLLS;
