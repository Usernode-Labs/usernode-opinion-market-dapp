/**
 * Daily BTC Price Prediction — server-side scheduler for Opinion Market.
 *
 * Each UTC day this module:
 *   1. Fetches the current BTC/USD spot from the free, keyless CoinGecko API.
 *   2. Resolves the previous day's question against that real price by posting
 *      a `resolve_btc` memo on-chain (winner = higher / lower / push).
 *   3. Opens a fresh question "Will BTC be higher or lower than $X by tomorrow?"
 *      with X = the just-read price, by posting a `create_daily_btc` memo.
 *
 * Both memos are server-authored and signed through the SAME wallet path as
 * vote-encryption.js's key txs (injected `sendMemo`). The strike and the
 * resolved price are baked into the memos so that the shared replay module
 * (`public/opinion-market-state.js`) — which must stay pure and deterministic
 * — only ever READS prices off-chain and never calls CoinGecko itself.
 *
 * Idempotency / determinism:
 *   - Survey ids are deterministic per UTC day (`btc-daily-YYYY-MM-DD`), so a
 *     restart, a missed tick, or a second co-operating deploy sharing
 *     APP_PUBKEY all collapse to a single survey in replay.
 *   - Before creating/resolving, we read the live raw-tx feed and skip any
 *     work that already exists on-chain. Duplicate sends that still slip
 *     through (parallel deploys racing) are reconciled by replay's
 *     earliest-memo-wins rule.
 */

"use strict";

const https = require("https");

const APP_ID = "opinion-market";
const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";
const DAY_MS = 86400000;
// Only auto-resolve a question whose expiry is within this window. A question
// missed for longer than this stays `pending` rather than being resolved
// against a price from days later (which would be wrong).
const RESOLVE_GRACE_MS = 2 * DAY_MS;
// Fire shortly AFTER the UTC midnight boundary so the day has cleanly rolled
// over before we compute `today` / `yesterday`.
const POST_MIDNIGHT_OFFSET_MS = 60 * 1000;

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

function fetchBtcPrice() {
  return new Promise((resolve, reject) => {
    const req = https.get(COINGECKO_URL, { headers: { accept: "application/json" } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString());
          const p = j && j.bitcoin && j.bitcoin.usd;
          if (typeof p !== "number" || !Number.isFinite(p) || p <= 0) {
            return reject(new Error("bad price payload"));
          }
          resolve(p);
        } catch (e) {
          reject(new Error(`JSON parse: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("coingecko timeout")));
  });
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
  let timer = null;
  let stopped = false;

  async function tick() {
    const now = nowFn();

    let price;
    try {
      price = await fetchBtcPrice();
    } catch (e) {
      console.warn(`[daily-btc] price fetch failed, skipping tick: ${e.message}`);
      return;
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
        if (ok) console.log(`[daily-btc] resolved ${sv.id}: $${price} vs strike $${sv.strikeUsd} -> ${winner || "push"}`);
      } catch (e) {
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
        if (ok) console.log(`[daily-btc] created ${id} @ strike $${price}`);
      } catch (e) {
        console.error(`[daily-btc] create send error (${id}): ${e.message}`);
      }
    }
  }

  function safeTick() {
    return tick().catch((e) => console.error(`[daily-btc] tick error: ${e.message}`));
  }

  function scheduleNext() {
    if (stopped) return;
    const now = nowFn();
    const fireAt = nextUtcMidnight(now) + POST_MIDNIGHT_OFFSET_MS;
    const delay = Math.max(1000, fireAt - now);
    timer = setTimeout(async () => {
      await safeTick();
      scheduleNext();
    }, delay);
    if (timer.unref) timer.unref();
  }

  function start() {
    // Startup catch-up: backfill a missed boundary immediately, then align to
    // the next UTC midnight. A short delay lets the chain poller warm its
    // raw-tx cache first so the idempotency check sees existing state.
    const warmup = setTimeout(() => safeTick(), 10000);
    if (warmup.unref) warmup.unref();
    scheduleNext();
    console.log("[daily-btc] scheduler started (UTC-daily)");
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
  }

  return { start, stop, tick: safeTick, _parseExisting: () => parseExisting(getRawTransactions, appPubkey) };
}

module.exports = createDailyBtc;
module.exports.utcDayId = utcDayId;
module.exports.nextUtcMidnight = nextUtcMidnight;
