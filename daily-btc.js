/**
 * Daily BTC Price Prediction — server-side scheduler for Opinion Market.
 *
 * Each UTC day this module:
 *   1. Fetches the current BTC/USD spot from a set of free, keyless price APIs
 *      (CoinGecko first, then Coinbase / Binance / Kraken as fallbacks).
 *   2. Resolves the previous day's question against that real price by posting
 *      a `resolve_btc` memo on-chain (winner = higher / lower / push).
 *   3. Opens a fresh question "Will BTC be higher or lower than $X by tomorrow?"
 *      with X = the just-read price, by posting a `create_daily_btc` memo.
 *
 * Both memos are server-authored and signed through the SAME wallet path as
 * vote-encryption.js's key txs (injected `sendMemo`). The strike and the
 * resolved price are baked into the memos so that the shared replay module
 * (`public/opinion-market-state.js`) — which must stay pure and deterministic
 * — only ever READS prices off-chain and never calls a price API itself.
 *
 * Resilience (why this module won't silently go dark for a day):
 *   - Price acquisition is multi-source with bounded retry+backoff. A single
 *     provider being blocked, rate-limited, or slow does not zero out the day —
 *     the first source that returns a finite positive USD price wins.
 *   - In addition to the UTC-midnight tick, a periodic SAFETY tick re-attempts
 *     every ~45 min. Creation is idempotent (deterministic per-day id + an
 *     on-chain existence check), so as soon as ANY price source is reachable at
 *     any point in the day, today's question gets posted. A transient failure
 *     at the midnight instant no longer loses the whole day.
 *   - Last successful create/resolve timestamps and the last price error are
 *     tracked and exposed via getStatus() so "no question today" is observable
 *     (surfaced on /health and the POST /__om/daily-btc/tick route in server.js)
 *     instead of looking identical to "everything is fine".
 *
 * Idempotency / determinism:
 *   - Survey ids are deterministic per UTC day (`btc-daily-YYYY-MM-DD`), so a
 *     restart, a missed tick, a safety tick, or a second co-operating deploy
 *     sharing APP_PUBKEY all collapse to a single survey in replay.
 *   - Before creating/resolving, we read the live raw-tx feed and skip any
 *     work that already exists on-chain. Duplicate sends that still slip
 *     through (parallel deploys racing) are reconciled by replay's
 *     earliest-memo-wins rule.
 */

"use strict";

const https = require("https");

const APP_ID = "opinion-market";
const DAY_MS = 86400000;
// Only auto-resolve a question whose expiry is within this window. A question
// missed for longer than this stays `pending` rather than being resolved
// against a price from days later (which would be wrong).
const RESOLVE_GRACE_MS = 2 * DAY_MS;
// Fire shortly AFTER the UTC midnight boundary so the day has cleanly rolled
// over before we compute `today` / `yesterday`.
const POST_MIDNIGHT_OFFSET_MS = 60 * 1000;
// Periodic re-attempt independent of the midnight boundary. Idempotent, so it
// no-ops once today's question exists; its job is to recover from a transient
// price-source or send failure without waiting until the next UTC day.
const SAFETY_TICK_MS = 45 * 60 * 1000;

// Per-request HTTP timeout for a single price source.
const PRICE_HTTP_TIMEOUT_MS = 15000;
// Bounded retry across the whole source list: this many rounds, with the
// backoff below between rounds (kept tight so a slow provider can't stall the
// safety tick for long).
const PRICE_RETRY_BACKOFFS_MS = [2000, 5000, 10000];

// Keyless BTC/USD spot sources, tried in order each round. Each parser returns
// a number or throws; the value is validated finite + positive by the caller.
const PRICE_SOURCES = [
  {
    name: "coingecko",
    url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
    parse: (j) => j && j.bitcoin && j.bitcoin.usd,
  },
  {
    name: "coinbase",
    url: "https://api.coinbase.com/v2/prices/BTC-USD/spot",
    parse: (j) => j && j.data && parseFloat(j.data.amount),
  },
  {
    name: "binance",
    url: "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
    parse: (j) => j && parseFloat(j.price),
  },
  {
    name: "kraken",
    url: "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
    parse: (j) => {
      if (!j || !j.result) return null;
      // Kraken keys the pair as XXBTZUSD; be tolerant of the exact key.
      const key = Object.keys(j.result)[0];
      const r = key ? j.result[key] : null;
      return r && r.c && parseFloat(r.c[0]);
    },
  },
];

function utcDayId(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function nextUtcMidnight(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

function fmtUsd(n) {
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function delay(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t.unref) t.unref();
  });
}

// GET a URL and JSON-parse the body. Rejects on non-2xx, timeout, or bad JSON.
function httpGetJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { accept: "application/json" } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (e) {
          reject(new Error(`JSON parse: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
  });
}

// Try one source; return a finite positive USD price or throw.
async function fetchFromSource(src) {
  const j = await httpGetJson(src.url, PRICE_HTTP_TIMEOUT_MS);
  const p = src.parse(j);
  if (typeof p !== "number" || !Number.isFinite(p) || p <= 0) {
    throw new Error("bad price payload");
  }
  return p;
}

// Multi-source, bounded-retry BTC/USD fetch. Each round walks the source list
// in order and returns the first finite positive price; rounds are separated by
// PRICE_RETRY_BACKOFFS_MS. Throws an aggregated error only if every source
// fails every round.
async function fetchBtcPrice() {
  const rounds = PRICE_RETRY_BACKOFFS_MS.length + 1;
  let lastErrs = [];
  for (let round = 0; round < rounds; round++) {
    lastErrs = [];
    for (const src of PRICE_SOURCES) {
      try {
        return await fetchFromSource(src);
      } catch (e) {
        lastErrs.push(`${src.name}: ${e.message}`);
      }
    }
    if (round < PRICE_RETRY_BACKOFFS_MS.length) {
      await delay(PRICE_RETRY_BACKOFFS_MS[round]);
    }
  }
  throw new Error(`all price sources failed (${lastErrs.join("; ")})`);
}

function txTimestampMs(tx) {
  if (typeof tx.timestamp_ms === "number") return tx.timestamp_ms;
  if (typeof tx.created_at === "number") return tx.created_at;
  if (typeof tx.created_at === "string") {
    const t = Date.parse(tx.created_at);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

// Scan the raw-tx feed for daily-BTC state. Returns a map of created
// questions (id -> { id, strikeUsd, createdAtMs, expiresAtMs }) and a set of
// already-resolved survey ids. Pure read; this is what makes the tick
// idempotent across restarts and parallel deploys.
function parseExisting(getRawTransactions, appPubkey) {
  const created = new Map();
  const resolved = new Set();
  const txs = (getRawTransactions && getRawTransactions()) || [];
  for (const tx of txs) {
    const to = tx.destination_pubkey || tx.to || tx.destination;
    if (to !== appPubkey) continue;
    let memo;
    try { memo = typeof tx.memo === "string" ? JSON.parse(tx.memo) : tx.memo; }
    catch (_) { continue; }
    if (!memo || memo.app !== APP_ID) continue;

    if (memo.type === "create_daily_btc" && memo.survey && memo.survey.id) {
      const s = memo.survey;
      if (created.has(s.id)) continue;
      const createdAtMs = txTimestampMs(tx) || (typeof s.priced_at === "number" ? s.priced_at : null);
      const dur = s.active_duration_ms || DAY_MS;
      created.set(s.id, {
        id: s.id,
        strikeUsd: typeof s.strike_usd === "number" ? s.strike_usd : null,
        createdAtMs,
        expiresAtMs: createdAtMs ? createdAtMs + dur : null,
      });
    } else if (memo.type === "resolve_btc" && memo.survey != null) {
      resolved.add(String(memo.survey));
    }
  }
  return { created, resolved };
}

function createDailyBtc(opts) {
  const appPubkey = opts.appPubkey;
  const getRawTransactions = opts.getRawTransactions;
  const sendMemo = opts.sendMemo;
  const nowFn = opts.now || Date.now;
  let midnightTimer = null;
  let safetyTimer = null;
  let stopped = false;

  // In-memory observability. Surfaced via getStatus() on /health and the
  // manual-trigger route so "no question today" is detectable without grepping
  // logs. Reset only on process restart.
  const status = {
    startedAt: null,
    lastTickAt: null,
    lastPriceUsd: null,
    lastPriceError: null,
    lastCreateAt: null,
    lastCreateId: null,
    lastResolveAt: null,
    lastResolveId: null,
    lastSendError: null,
  };

  async function tick() {
    const now = nowFn();
    status.lastTickAt = now;

    let price;
    try {
      price = await fetchBtcPrice();
      status.lastPriceUsd = price;
      status.lastPriceError = null;
    } catch (e) {
      status.lastPriceError = e.message;
      console.warn(`[daily-btc] price fetch failed, skipping tick: ${e.message}`);
      return getStatus();
    }

    const { created, resolved } = parseExisting(getRawTransactions, appPubkey);

    // 1) Resolve any expired-but-unresolved question inside the grace window.
    for (const sv of created.values()) {
      if (!sv.expiresAtMs || resolved.has(sv.id)) continue;
      if (now < sv.expiresAtMs) continue;                      // not expired yet
      if (now - sv.expiresAtMs > RESOLVE_GRACE_MS) continue;   // too stale → leave pending
      if (typeof sv.strikeUsd !== "number") continue;          // can't resolve without a strike
      const winner = price > sv.strikeUsd ? "higher" : (price < sv.strikeUsd ? "lower" : null);
      const memo = {
        app: APP_ID, type: "resolve_btc", survey: sv.id,
        strike_usd: sv.strikeUsd, resolved_price_usd: price, resolved_at: now, winner,
      };
      try {
        const ok = await sendMemo(memo);
        if (ok) {
          status.lastResolveAt = now;
          status.lastResolveId = sv.id;
          status.lastSendError = null;
          console.log(`[daily-btc] resolved ${sv.id}: $${price} vs strike $${sv.strikeUsd} -> ${winner || "push"}`);
        } else {
          status.lastSendError = `resolve ${sv.id}: send rejected`;
          console.error(`[daily-btc] resolve send rejected (${sv.id})`);
        }
      } catch (e) {
        status.lastSendError = `resolve ${sv.id}: ${e.message}`;
        console.error(`[daily-btc] resolve send error (${sv.id}): ${e.message}`);
      }
    }

    // 2) Create today's question if it doesn't already exist on-chain.
    const id = "btc-daily-" + utcDayId(now);
    if (!created.has(id)) {
      const memo = {
        app: APP_ID, type: "create_daily_btc",
        survey: {
          id,
          title: "Daily BTC",
          question: `Will BTC be higher or lower than $${fmtUsd(price)} by tomorrow?`,
          options: [{ key: "higher", label: "Higher" }, { key: "lower", label: "Lower" }],
          active_duration_ms: DAY_MS,
          reveal_interval_ms: null,
          allow_custom_options: false,
          kind: "btc_daily",
          strike_usd: price,
          priced_at: now,
        },
      };
      try {
        const ok = await sendMemo(memo);
        if (ok) {
          status.lastCreateAt = now;
          status.lastCreateId = id;
          status.lastSendError = null;
          console.log(`[daily-btc] created ${id} @ strike $${price}`);
        } else {
          status.lastSendError = `create ${id}: send rejected`;
          console.error(`[daily-btc] create send rejected (${id}) — is SENDER_APP_SECRET_KEY configured?`);
        }
      } catch (e) {
        status.lastSendError = `create ${id}: ${e.message}`;
        console.error(`[daily-btc] create send error (${id}): ${e.message}`);
      }
    }

    return getStatus();
  }

  function safeTick() {
    return tick().catch((e) => {
      console.error(`[daily-btc] tick error: ${e.message}`);
      return getStatus();
    });
  }

  // Snapshot of scheduler health + whether today's question is already on-chain.
  function getStatus() {
    const now = nowFn();
    const todayId = "btc-daily-" + utcDayId(now);
    let todayExists = false;
    try {
      const { created } = parseExisting(getRawTransactions, appPubkey);
      todayExists = created.has(todayId);
    } catch (_) { /* best-effort */ }
    return {
      todayQuestionId: todayId,
      todayExists,
      startedAt: status.startedAt,
      lastTickAt: status.lastTickAt,
      lastPriceUsd: status.lastPriceUsd,
      lastPriceError: status.lastPriceError,
      lastCreateAt: status.lastCreateAt,
      lastCreateId: status.lastCreateId,
      lastResolveAt: status.lastResolveAt,
      lastResolveId: status.lastResolveId,
      lastSendError: status.lastSendError,
    };
  }

  function scheduleNextMidnight() {
    if (stopped) return;
    const now = nowFn();
    const fireAt = nextUtcMidnight(now) + POST_MIDNIGHT_OFFSET_MS;
    const wait = Math.max(1000, fireAt - now);
    midnightTimer = setTimeout(async () => {
      await safeTick();
      scheduleNextMidnight();
    }, wait);
    if (midnightTimer.unref) midnightTimer.unref();
  }

  function start() {
    status.startedAt = nowFn();
    // Startup catch-up: backfill a missed boundary immediately, then align to
    // the next UTC midnight. A short delay lets the chain poller warm its
    // raw-tx cache first so the idempotency check sees existing state.
    const warmup = setTimeout(() => safeTick(), 10000);
    if (warmup.unref) warmup.unref();
    scheduleNextMidnight();
    // Periodic safety net: recover from a transient price/send failure without
    // waiting for the next UTC day. Idempotent — no-ops once today exists.
    safetyTimer = setInterval(() => safeTick(), SAFETY_TICK_MS);
    if (safetyTimer.unref) safetyTimer.unref();
    console.log("[daily-btc] scheduler started (UTC-daily + safety tick every " + Math.round(SAFETY_TICK_MS / 60000) + "m)");
  }

  function stop() {
    stopped = true;
    if (midnightTimer) clearTimeout(midnightTimer);
    if (safetyTimer) clearInterval(safetyTimer);
  }

  return {
    start,
    stop,
    tick: safeTick,
    getStatus,
    _parseExisting: () => parseExisting(getRawTransactions, appPubkey),
  };
}

module.exports = createDailyBtc;
module.exports.utcDayId = utcDayId;
module.exports.nextUtcMidnight = nextUtcMidnight;
module.exports.fetchBtcPrice = fetchBtcPrice;
