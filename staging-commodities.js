/**
 * Staging-only seed for demo Commodity markets.
 *
 * Commodity markets are ordinary user-created surveys (`create_survey` with
 * `category: "commodity"` + a `commodity` slug) — unlike Daily BTC / World
 * Cup / Daily News there is no server scheduler that posts them. So a fresh
 * staging/preview container would show an EMPTY Commodity filter. This module
 * injects a couple of obviously-fake demo commodity questions straight into
 * the cache's raw-tx feed (the same feed the client + leaderboard replay),
 * exactly like daily-btc.js's `seedStaging()`.
 *
 * Strictly staging-only: `server.js` constructs this with a non-null
 * `seedTransaction` ONLY when `IS_STAGING`. In production this file is never
 * invoked. The seeds are idempotent via stable tx ids (the cache dedups on
 * `seenTxIds`), so re-running on every boot is a no-op after the first.
 *
 * Commodities behave exactly like any other opinion market: the price target
 * lives in the question text (set manually), there is no external price feed.
 */
"use strict";

// 7 days — matches the default survey duration in opinion-market-state.js so
// the seeded markets stay active across a staging review window.
var SEVEN_DAYS_MS = 7 * 86400000;

// Obviously-fake demo questions. The "Staging demo" prefix keeps them from
// being mistaken for real user content. Yes/No options model the natural
// shape of a commodity price question (see issue #33).
var DEMO_COMMODITY_SURVEYS = [
  {
    id: "staging-demo-commodity-gold",
    title: "Staging demo · Gold price",
    question: "Will gold close above $2,400/oz this week?",
    commodity: "gold",
  },
  {
    id: "staging-demo-commodity-oil",
    title: "Staging demo · Oil price",
    question: "Will Brent crude top $90/bbl this week?",
    commodity: "oil",
  },
];

function buildCreateMemo(def, createdAtMs) {
  return {
    app: "opinion-market",
    type: "create_survey",
    survey: {
      id: def.id,
      title: def.title,
      question: def.question,
      active_duration_ms: SEVEN_DAYS_MS,
      options: [
        { key: "yes", label: "Yes" },
        { key: "no", label: "No" },
      ],
      reveal_interval_ms: null,
      allow_custom_options: false,
      category: "commodity",
      commodity: def.commodity,
    },
  };
}

/**
 * @param {object} opts
 * @param {string} opts.appPubkey       Recipient address every OM action targets.
 * @param {string} opts.senderPubkey    Synthetic author of the demo surveys.
 * @param {function|null} opts.seedTransaction  Cache injector (staging only).
 */
function createStagingCommodities(opts) {
  opts = opts || {};
  var appPubkey = opts.appPubkey;
  var senderPubkey = opts.senderPubkey || appPubkey;
  var seedTransaction = opts.seedTransaction || null;
  var status = { seeded: [], lastSeedAt: null, lastError: null };

  function seed() {
    if (!seedTransaction) return status; // production / non-staging: no-op
    var now = Date.now();
    DEMO_COMMODITY_SURVEYS.forEach(function (def) {
      var memo = buildCreateMemo(def, now);
      var seedTxId = "staging-seed-" + def.id;
      var tx = {
        tx_id: seedTxId,
        id: seedTxId,
        from_pubkey: senderPubkey,
        destination_pubkey: appPubkey,
        amount: 1,
        memo: JSON.stringify(memo),
        created_at: new Date(now).toISOString(),
      };
      try {
        seedTransaction(tx);
        if (status.seeded.indexOf(def.id) === -1) status.seeded.push(def.id);
        status.lastSeedAt = now;
        status.lastError = null;
        console.log("[staging-commodities] seeded " + def.id + " (" + def.commodity + ")");
      } catch (e) {
        status.lastError = def.id + ": " + e.message;
        console.error("[staging-commodities] seed error (" + def.id + "): " + e.message);
      }
    });
    return status;
  }

  function getStatus() { return status; }

  return { seed: seed, getStatus: getStatus };
}

module.exports = { createStagingCommodities: createStagingCommodities };
