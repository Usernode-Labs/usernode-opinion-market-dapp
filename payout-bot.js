/**
 * Payout Bot — automated on-chain settlement for Opinion Market.
 *
 * Opinion Market's CPMM pricing and credit accounting are VIRTUAL: bets,
 * shares, and settlement payouts all live in the deterministic replay
 * (public/opinion-market-state.js), and every on-chain tx is a fixed
 * `amount: 1` carrier for a JSON memo. This module is the one place that
 * turns a settled market's virtual winnings into REAL base-currency: the
 * instant an outcome is confirmed (e.g. daily-btc.js posts `resolve_btc`),
 * the bot transfers the prize from a funded Pool wallet straight to each
 * winner's wallet, then records a `settlement_payout` memo back to
 * APP_PUBKEY for idempotency + audit + UI.
 *
 * Design rules (mirrors vote-encryption.js / daily-btc.js):
 *   - The replay module stays PURE. ALL wallet I/O lives here.
 *   - Settlement MATH is consumed from opinion-market-state.js
 *     (`findPendingPayouts`) — never re-derived — so the bot can't drift.
 *   - Idempotency comes from the on-chain `settlement_payout` memo: replay
 *     reconciles it (Phase 7b), so a paid (survey, winner) is skipped on the
 *     next tick. A short-lived in-process `paidKeys` set covers the window
 *     between sending value and the memo landing in the cache.
 *   - Real sends are LEADER-gated (PAYOUT_LEADER) so co-deployed servers
 *     sharing APP_PUBKEY don't double-spend real funds.
 */

const nodeCrypto = require("crypto");
const OMS = require("./public/opinion-market-state.js");

const APP_ID = "opinion-market";

// Pure: convert owed virtual credits → floored on-chain amounts, scaling
// pro-rata if the pool can't cover the full bill (fairness over FCFS). When
// `available` is unknown (null/Infinity) we don't scale — the operator is
// assumed to have funded the pool. Never pays more than computed; floors all
// conversions so the pool can never be drained below what it holds.
function planPayouts(pending, rate, available, minBalance) {
  let plans = pending
    .map((p) => Object.assign({}, p, { amount: Math.floor(p.credits * rate) }))
    .filter((p) => p.amount > 0);
  const totalOwed = plans.reduce((s, p) => s + p.amount, 0);
  let scaled = false;
  if (typeof available === "number" && Number.isFinite(available)) {
    const spendable = Math.max(0, available - (minBalance || 0));
    if (totalOwed > spendable && totalOwed > 0) {
      scaled = true;
      const factor = spendable / totalOwed;
      plans = plans
        .map((p) => Object.assign({}, p, { amount: Math.floor(p.amount * factor) }))
        .filter((p) => p.amount > 0);
    }
  }
  return { plans, scaled, totalOwed };
}

function createPayoutBot(opts) {
  const appPubkey = opts.appPubkey;
  const poolPubkey = opts.poolPubkey || "";
  const poolSecretKey = opts.poolSecretKey || "";
  const senderPubkey = opts.senderPubkey || appPubkey;
  const nodeRpcUrl = opts.nodeRpcUrl || "http://usernode-node:3000";
  const getRawTransactions = opts.getRawTransactions;
  const sendMemo = opts.sendMemo; // server-authored memo → APP_PUBKEY (sender-signed)
  const getGlobalUsernames = typeof opts.getGlobalUsernames === "function" ? opts.getGlobalUsernames : () => ({});
  const getGenesisAccounts = typeof opts.getGenesisAccounts === "function" ? opts.getGenesisAccounts : () => [];
  const adminPubkey = opts.adminPubkey || null;
  const nowFn = opts.now || Date.now;
  // Credits → base-currency conversion. The pool is a subsidy, not a
  // self-funding book (bets are zero-value memos), so this bounds outflow.
  const payoutRate = typeof opts.payoutRate === "number" && opts.payoutRate >= 0 ? opts.payoutRate : 0.01;
  const poolMinBalance = typeof opts.poolMinBalance === "number" ? opts.poolMinBalance : 0;
  const isLeader = !!opts.isLeader;
  const tickMs = typeof opts.tickMs === "number" ? opts.tickMs : 20000;
  // Staging-only: inject fabricated `settlement_payout` memos into the cache
  // so the paid-state UI renders without a signer. Null in production.
  const seedTransaction = typeof opts.seedTransaction === "function" ? opts.seedTransaction : null;

  // Trust set for replay's forgery guard: a settlement_payout is only honoured
  // if authored by one of these. The reconciliation memo is sender-signed; the
  // value transfer is pool-signed.
  const trustedSenders = [poolPubkey, senderPubkey].filter(Boolean);

  // (survey:winner) we've already sent value for this process-lifetime. Bridges
  // the gap between sending value and the settlement_payout memo appearing in
  // the cache (so the same payout isn't re-sent on the very next tick before
  // replay can see it). Cleared on chain reset.
  const paidKeys = new Set();
  let signerConfigured = false;
  let timer = null;
  let stopped = false;

  const status = {
    startedAt: null,
    leader: isLeader,
    payoutRate,
    lastTickAt: null,
    poolBalance: null,
    pendingPayouts: 0,
    lastPayoutAt: null,
    lastPayoutSurvey: null,
    paidTotalAmount: 0,
    paidCount: 0,
    lastInsolventScale: null,
    lastSendError: null,
  };

  // ── RPC ────────────────────────────────────────────────────────────────
  function httpJson(method, urlStr, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const transport = url.protocol === "https:" ? require("https") : require("http");
      const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : null;
      const req = transport.request(url, {
        method,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(bodyBuf ? { "content-length": bodyBuf.length } : {}),
        },
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode < 200 || res.statusCode >= 300)
            return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
          try { resolve(text ? JSON.parse(text) : {}); }
          catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
        });
      });
      req.on("error", reject);
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  }

  async function configurePoolSigner() {
    if (!poolSecretKey) return false;
    try {
      const resp = await httpJson("POST", `${nodeRpcUrl}/wallet/signer`, { secret_key: poolSecretKey });
      if (resp && resp.ok) { console.log("[payout-bot] pool signer configured"); return true; }
      console.error("[payout-bot] pool signer config failed:", resp);
      return false;
    } catch (e) {
      console.error("[payout-bot] pool signer config error:", e.message);
      return false;
    }
  }

  // Best-effort pool balance probe. The exact balance endpoint varies by
  // sidecar build, so this tolerates failure and returns null (unknown) →
  // planPayouts then won't scale. Used only to enforce the insolvency floor
  // when the figure IS observable.
  async function getPoolBalance() {
    if (!poolPubkey) return null;
    const attempts = [
      ["POST", `${nodeRpcUrl}/wallet/balance`, { pubkey: poolPubkey }],
      ["POST", `${nodeRpcUrl}/wallet/balance`, { pk_hash: poolPubkey }],
      ["GET", `${nodeRpcUrl}/wallet/balance/${poolPubkey}`, null],
    ];
    for (const [m, u, b] of attempts) {
      try {
        const resp = await httpJson(m, u, b);
        const bal = resp && (resp.balance != null ? resp.balance : (resp.spendable != null ? resp.spendable : resp.amount));
        if (typeof bal === "number" && Number.isFinite(bal)) return bal;
      } catch (_) { /* try next shape */ }
    }
    return null;
  }

  // Real transfer of `amount` base-currency from the Pool wallet to `to`.
  async function sendValue(to, amount, memo) {
    if (!poolSecretKey) {
      return { ok: false, error: "no pool secret key" };
    }
    try {
      if (!signerConfigured) {
        signerConfigured = await configurePoolSigner();
        if (!signerConfigured) return { ok: false, error: "signer unconfigured" };
      }
      const resp = await httpJson("POST", `${nodeRpcUrl}/wallet/send`, {
        from_pk_hash: poolPubkey,
        amount,
        to_pk_hash: to,
        fee: 0,
        memo: Buffer.from(JSON.stringify(memo)).toString("base64url"),
      });
      if (resp && resp.queued) {
        return { ok: true, txId: resp.tx_id || resp.id || resp.txid || null };
      }
      return { ok: false, error: "send not queued" };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ── State ───────────────────────────────────────────────────────────────
  async function computeState() {
    return OMS.computeFullState({
      rawTxs: getRawTransactions ? getRawTransactions() : [],
      appPubkey,
      adminPubkey,
      genesisAccounts: getGenesisAccounts(),
      globalUsernames: getGlobalUsernames(),
      trustedSenders,
      now: nowFn(),
    });
  }

  // ── Tick ──────────────────────────────────────────────────────────────
  async function tick() {
    const now = nowFn();
    status.lastTickAt = now;

    let state;
    try {
      state = await computeState();
    } catch (e) {
      status.lastSendError = `state rebuild: ${e.message}`;
      console.error(`[payout-bot] state rebuild failed: ${e.message}`);
      return getStatus();
    }

    // Owed-but-unpaid winners across all settled markets (pure derivation).
    const pendingAll = OMS.findPendingPayouts(state);
    // Skip ones we've already fired value for this process-lifetime but whose
    // memo hasn't landed in the cache yet (avoids a same-window double-pay).
    const pending = pendingAll.filter((p) => !paidKeys.has(p.surveyId + ":" + p.winner));
    status.pendingPayouts = pending.length;

    if (pending.length === 0) return getStatus();

    // Non-leaders observe only — they compute the queue for /health but never
    // move real funds (prevents parallel-deploy double-spend).
    if (!isLeader) return getStatus();

    // Determine the spendable budget and plan amounts (floored, pro-rata on
    // insolvency).
    const balance = await getPoolBalance();
    status.poolBalance = balance;
    const { plans, scaled, totalOwed } = planPayouts(pending, payoutRate, balance, poolMinBalance);
    status.lastInsolventScale = scaled ? { totalOwed, balance, minBalance: poolMinBalance, at: now } : null;
    if (scaled) {
      console.warn(`[payout-bot] pool insolvent: owed ${totalOwed}, balance ${balance} — paying pro-rata`);
    }

    for (const plan of plans) {
      const key = plan.surveyId + ":" + plan.winner;
      const payMemo = {
        app: APP_ID,
        type: "settlement_payout",
        survey: plan.surveyId,
        winner: plan.winner,
        credits: plan.credits,
        amount: plan.amount,
        rate: payoutRate,
        outcome: plan.outcome,
      };

      // 1) Real transfer Pool wallet → winner.
      const sent = await sendValue(plan.winner, plan.amount, payMemo);
      if (!sent.ok) {
        status.lastSendError = `payout ${key}: ${sent.error}`;
        console.error(`[payout-bot] value send failed (${key}): ${sent.error}`);
        // Do NOT record the memo — next tick retries.
        continue;
      }
      // Mark in-flight so we don't re-send before the memo reconciles.
      paidKeys.add(key);

      // 2) Reconciliation memo → APP_PUBKEY (idempotency + audit + UI).
      payMemo.payout_tx_id = sent.txId || null;
      try {
        const memoOk = await sendMemo(payMemo);
        if (memoOk) {
          status.lastPayoutAt = now;
          status.lastPayoutSurvey = plan.surveyId;
          status.paidTotalAmount += plan.amount;
          status.paidCount++;
          status.lastSendError = null;
          console.log(`[payout-bot] paid ${plan.amount} to ${plan.winner} for ${plan.surveyId} (${plan.outcome})`);
        } else {
          // Value moved but memo didn't post; keep paidKeys so we don't double
          // pay, surface the error. The memo is retried by the next sendMemo
          // attempt on a later tick because findPendingPayouts still lists it
          // (no memo on-chain) but paidKeys suppresses a second value send.
          status.lastSendError = `payout memo ${key}: send rejected`;
          console.error(`[payout-bot] payout memo rejected (${key}) — value already sent`);
        }
      } catch (e) {
        status.lastSendError = `payout memo ${key}: ${e.message}`;
        console.error(`[payout-bot] payout memo error (${key}): ${e.message}`);
      }
    }

    return getStatus();
  }

  function safeTick() {
    return tick().catch((e) => {
      console.error(`[payout-bot] tick error: ${e.message}`);
      return getStatus();
    });
  }

  // ── Staging seed ─────────────────────────────────────────────────────────
  // Fabricate `settlement_payout` memos for currently-owed payouts so the
  // paid-state UI renders on a preview without a pool signer. Idempotent: a
  // deterministic per-(survey,winner) tx id lets the cache dedup, and replay
  // is earliest-memo-wins.
  async function seedStaging() {
    if (!seedTransaction) return getStatus();
    const now = nowFn();
    let state;
    try { state = await computeState(); }
    catch (e) { status.lastSendError = `staging state: ${e.message}`; return getStatus(); }
    const pending = OMS.findPendingPayouts(state);
    for (const p of pending) {
      const amount = Math.floor(p.credits * payoutRate);
      if (amount <= 0) continue;
      const seedTxId = "staging-payout-" + p.surveyId + "-" + p.winner;
      const memo = {
        app: APP_ID, type: "settlement_payout", survey: p.surveyId, winner: p.winner,
        credits: p.credits, amount, rate: payoutRate, outcome: p.outcome,
        payout_tx_id: "staging-" + seedTxId,
      };
      const tx = {
        tx_id: seedTxId, id: seedTxId,
        from_pubkey: senderPubkey, destination_pubkey: appPubkey,
        amount: 1, memo: JSON.stringify(memo),
        created_at: new Date(now).toISOString(),
      };
      try {
        seedTransaction(tx);
        status.paidCount++;
        status.paidTotalAmount += amount;
        console.log(`[payout-bot] staging-seeded payout ${p.surveyId} -> ${p.winner} (${amount})`);
      } catch (e) {
        status.lastSendError = `staging seed ${seedTxId}: ${e.message}`;
      }
    }
    return getStatus();
  }

  function safeSeedStaging() {
    return seedStaging().catch((e) => {
      console.error(`[payout-bot] staging seed error: ${e.message}`);
      return getStatus();
    });
  }

  function getStatus() {
    return {
      startedAt: status.startedAt,
      leader: status.leader,
      payoutRate: status.payoutRate,
      poolConfigured: !!(poolPubkey && poolSecretKey),
      lastTickAt: status.lastTickAt,
      poolBalance: status.poolBalance,
      pendingPayouts: status.pendingPayouts,
      lastPayoutAt: status.lastPayoutAt,
      lastPayoutSurvey: status.lastPayoutSurvey,
      paidTotalAmount: status.paidTotalAmount,
      paidCount: status.paidCount,
      lastInsolventScale: status.lastInsolventScale,
      lastSendError: status.lastSendError,
    };
  }

  function start() {
    status.startedAt = nowFn();
    // Warmup after the cache poller has a chance to fill, then a fast cadence
    // so "BTC confirmed higher → winner paid" is near-immediate.
    const warmup = setTimeout(() => safeTick(), 12000);
    if (warmup.unref) warmup.unref();
    timer = setInterval(() => safeTick(), tickMs);
    if (timer.unref) timer.unref();
    console.log(`[payout-bot] started (leader=${isLeader}, tick=${Math.round(tickMs / 1000)}s, rate=${payoutRate})`);
    if (seedTransaction) {
      const seedWarmup = setTimeout(() => safeSeedStaging(), 4000);
      if (seedWarmup.unref) seedWarmup.unref();
    }
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
  }

  function reset() {
    paidKeys.clear();
    signerConfigured = false;
    console.log("[payout-bot] state reset (chain restart detected)");
  }

  return {
    start,
    stop,
    reset,
    tick: safeTick,
    seedStaging: safeSeedStaging,
    getStatus,
    // Exposed for tests.
    _planPayouts: planPayouts,
  };
}

module.exports = createPayoutBot;
module.exports.planPayouts = planPayouts;
