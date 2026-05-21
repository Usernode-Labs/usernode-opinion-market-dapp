/**
 * Opinion Market State — pure state-rebuild logic for prediction markets.
 *
 * Usable in browser (script tag) and Node (require). No DOM or browser
 * APIs. Vote decryption uses WebCrypto (browser `crypto.subtle` or Node 16+
 * `require("crypto").webcrypto.subtle`).
 *
 * Shared single source of truth for:
 *   - `public/index.html`'s `rebuildState` (client UI)
 *   - `lib/leaderboard.js`'s `/leaderboard` JSON endpoint (server)
 *   - `simulate/replay.js` (diagnostic CLI)
 *
 * If the client and server replay disagree, that's a bug. Editing this
 * module changes both at once — that's the point. Do not fork the
 * `computeFullState` pipeline back into either consumer.
 *
 * @example Browser:
 *   <script src="opinion-market-state.js"></script>
 *   const state = await OpinionMarketState.computeFullState({ rawTxs, appPubkey, ... });
 * @example Node:
 *   const OMS = require('./opinion-market-state.js');
 *   const state = await OMS.computeFullState({ rawTxs, appPubkey, ... });
 */
(function (global) {
  "use strict";

  var CPMM = (typeof require !== "undefined" && typeof module !== "undefined")
    ? require("./opinion-market-core.js")
    : global.OpinionMarketCore;

  if (!CPMM) {
    throw new Error("OpinionMarketState: opinion-market-core.js must be loaded first");
  }

  /* ── Constants (must stay in lockstep with public/index.html UI) ────── */

  var INITIAL_CREDITS = 1000;
  var FEE_RATE = 0.05;
  var LIQUIDITY_FEE_RATE = 0.02;
  var MARKET_ANTE = 50;
  var PLATFORM_LIQUIDITY = 450;
  var CREATOR_REWARD_RATE = 0.005;
  var CREATOR_REWARD_CAP = 100;
  var MAX_BET_POOL_RATIO = 0.30;
  var SURVEY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
  var MAX_SURVEYS_PER_WINDOW = 999;
  var DEFAULT_SURVEY_DURATION_MS = 7 * 86400000;
  var ALLOWED_SURVEY_DURATION_MS = new Set([
    60000, 180000, 600000,
    2 * 86400000, 3 * 86400000, 4 * 86400000, 5 * 86400000, 6 * 86400000, 7 * 86400000,
    14 * 86400000, 30 * 86400000, 90 * 86400000,
  ]);
  var ALLOWED_REVEAL_INTERVALS = new Set([86400000, 172800000, 259200000, 604800000]);

  /* ── Tx normalization & parsing ───────────────────────────────────── */

  function pick(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      if (obj && obj[keys[i]] != null) return obj[keys[i]];
    }
    return null;
  }

  function extractTxTimestampMs(tx) {
    if (!tx || typeof tx !== "object") return null;
    var candidates = [tx.created_at, tx.createdAt, tx.timestamp_ms, tx.timestampMs, tx.timestamp, tx.time];
    for (var i = 0; i < candidates.length; i++) {
      var v = candidates[i];
      if (typeof v === "number" && Number.isFinite(v)) return v < 10000000000 ? v * 1000 : v;
      if (typeof v === "string" && v.trim()) {
        var t = Date.parse(v);
        if (!Number.isNaN(t)) return t;
      }
    }
    return null;
  }

  function normalizeTx(tx) {
    if (!tx || typeof tx !== "object") return null;
    var idV = pick(tx, ["id", "txid", "tx_id", "hash"]);
    var fromV = pick(tx, ["from_pubkey", "from", "source", "fromAddress", "from_address"]);
    var toV = pick(tx, ["destination_pubkey", "to", "destination", "toAddress", "to_address"]);
    var memoV = pick(tx, ["memo"]);
    return {
      id: idV == null ? null : String(idV),
      from: fromV == null ? null : String(fromV),
      to: toV == null ? null : String(toV),
      amount: pick(tx, ["amount"]),
      memo: memoV == null ? null : String(memoV),
      ts: extractTxTimestampMs(tx) || Date.now(),
      raw: tx,
    };
  }

  function parseMemo(m) {
    if (m == null) return null;
    try { return JSON.parse(String(m)); } catch (_) { return null; }
  }

  function makeParseAppTx(appPubkey) {
    return function parseAppTx(rawTx) {
      var tx = normalizeTx(rawTx);
      if (!tx || !tx.from || !tx.to || tx.to !== appPubkey) return null;
      var memoObj = parseMemo(tx.memo);
      if (!memoObj) return null;
      if (String(memoObj.app || "") !== "opinion-market") return null;
      return { tx: tx, memo: memoObj };
    };
  }

  /* ── String/username helpers ──────────────────────────────────────── */

  function slugify(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  }

  function last6(s) { var v = String(s || ""); return v.length >= 6 ? v.slice(-6) : v; }

  function usernameSuffix(address) { var c = last6(address); return c ? "_" + c : "_unknown"; }

  function deriveDefaultUsername(address) { return "user" + usernameSuffix(address); }

  function normalizeUsername(raw, fallback, addressForSuffix) {
    var suffix = usernameSuffix(addressForSuffix);
    var maxBaseLen = Math.max(1, 24 - suffix.length);
    var fallbackValue = (function () {
      var f = String(fallback || "").trim();
      if (!f) return "user" + suffix;
      if (f.endsWith(suffix)) return f.slice(0, maxBaseLen) + suffix;
      var stripped = f.replace(/_[A-Za-z0-9]{6}$/, "").slice(0, maxBaseLen);
      return (stripped || "user") + suffix;
    })();
    var v = String(raw || "").trim();
    if (!v) return fallbackValue;
    v = v.replace(/[^\w-]/g, "");
    if (!v) return fallbackValue;
    if (v.endsWith(suffix)) {
      var base1 = v.slice(0, -suffix.length).slice(0, maxBaseLen);
      return (base1 || "user") + suffix;
    }
    v = v.replace(/_[A-Za-z0-9]{6}$/, "");
    var base2 = v.slice(0, maxBaseLen);
    return (base2 || "user") + suffix;
  }

  /* ── Survey definition helpers ────────────────────────────────────── */

  function normalizeSurveyDurationMs(v) {
    var n = typeof v === "number" ? Math.round(v) : Number(v);
    if (!Number.isFinite(n)) return DEFAULT_SURVEY_DURATION_MS;
    return ALLOWED_SURVEY_DURATION_MS.has(n) ? n : DEFAULT_SURVEY_DURATION_MS;
  }

  function normalizeSurveyDefinition(rawSurvey) {
    if (!rawSurvey || typeof rawSurvey !== "object") return null;
    var title = String(rawSurvey.title || "").trim();
    var question = String(rawSurvey.question || "").trim();
    if (!title || !question) return null;
    var activeDurationMs = normalizeSurveyDurationMs(
      rawSurvey.active_duration_ms != null ? rawSurvey.active_duration_ms : rawSurvey.duration_ms
    );
    var optionsRaw = Array.isArray(rawSurvey.options) ? rawSurvey.options : [];
    var options = [];
    for (var i = 0; i < optionsRaw.length; i++) {
      var o = optionsRaw[i];
      if (!o || typeof o !== "object") continue;
      var label = String(o.label || "").trim();
      if (!label) continue;
      options.push({ key: String(o.key || slugify(label) || "opt_" + (i + 1)), label: label });
    }
    var idBase = String(rawSurvey.id || slugify(title) || "").trim();
    if (!idBase) return null;
    var revealRaw = rawSurvey.reveal_interval_ms;
    var revealIntervalMs = (typeof revealRaw === "number" && ALLOWED_REVEAL_INTERVALS.has(revealRaw)) ? revealRaw : null;
    var allowCustomOptions = rawSurvey.allow_custom_options !== false;
    return {
      id: idBase, title: title, question: question, activeDurationMs: activeDurationMs,
      options: options, revealIntervalMs: revealIntervalMs, allowCustomOptions: allowCustomOptions,
    };
  }

  function getRevealCheckpoints(survey) {
    if (!survey.revealIntervalMs) return [survey.expiresAtMs];
    var cps = [];
    var t = survey.createdAtMs + survey.revealIntervalMs;
    while (t <= survey.expiresAtMs) { cps.push(t); t += survey.revealIntervalMs; }
    if (cps.length === 0 || cps[cps.length - 1] !== survey.expiresAtMs) cps.push(survey.expiresAtMs);
    return cps;
  }

  /* ── CPMM market helpers ──────────────────────────────────────────── */

  function cpmmTotalLiquidity(mkt) {
    if (!mkt || !mkt.pools) return 0;
    var sum = 0;
    var pools = Object.values(mkt.pools);
    for (var i = 0; i < pools.length; i++) {
      var p = pools[i];
      if (p && typeof p.yes === "number" && typeof p.no === "number") sum += p.yes + p.no;
    }
    return sum;
  }

  function addPoolLiquidity(pools, amount) {
    var total = Object.values(pools).reduce(function (s, p) { return s + p.yes + p.no; }, 0);
    if (total <= 0 || amount <= 0) return;
    var scale = 1 + amount / total;
    var keys = Object.keys(pools);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      pools[k] = { yes: pools[k].yes * scale, no: pools[k].no * scale };
    }
  }

  function distributeRefund(mkt, settlement) {
    var pubkeys = Object.keys(mkt.userShares);
    for (var i = 0; i < pubkeys.length; i++) {
      var pubkey = pubkeys[i];
      var shares = mkt.userShares[pubkey];
      var optKeys = Object.keys(shares);
      for (var j = 0; j < optKeys.length; j++) {
        var optKey = optKeys[j];
        var s = shares[optKey];
        if (s <= 0) continue;
        var pool = mkt.pools[optKey];
        if (!pool) continue;
        var credits;
        if (CPMM.cpmmSellArbitrage && Object.keys(mkt.pools).length > 1) {
          var result = CPMM.cpmmSellArbitrage(mkt.pools, optKey, s);
          credits = result.creditsReceived;
          var npKeys = Object.keys(result.newPools);
          for (var k = 0; k < npKeys.length; k++) mkt.pools[npKeys[k]] = result.newPools[npKeys[k]];
        } else if (CPMM.cpmmSellYes) {
          credits = CPMM.cpmmSellYes(pool, s);
        } else {
          continue;
        }
        if (credits > 0) settlement.payouts[pubkey] = (settlement.payouts[pubkey] || 0) + credits;
      }
    }
    var noPubkeys = Object.keys(mkt.userNoShares || {});
    for (var ii = 0; ii < noPubkeys.length; ii++) {
      var pk = noPubkeys[ii];
      var noShares = mkt.userNoShares[pk];
      var noOpts = Object.keys(noShares);
      for (var jj = 0; jj < noOpts.length; jj++) {
        var optK = noOpts[jj];
        var ns = noShares[optK];
        if (ns <= 0) continue;
        var npool = mkt.pools[optK];
        if (!npool) continue;
        var ncredits;
        if (CPMM.cpmmSellArbitrageNo && Object.keys(mkt.pools).length > 1) {
          var nresult = CPMM.cpmmSellArbitrageNo(mkt.pools, optK, ns);
          ncredits = nresult.creditsReceived;
          var nnpKeys = Object.keys(nresult.newPools);
          for (var kk = 0; kk < nnpKeys.length; kk++) mkt.pools[nnpKeys[kk]] = nresult.newPools[nnpKeys[kk]];
        } else if (CPMM.cpmmSellNo) {
          ncredits = CPMM.cpmmSellNo(npool, ns);
        } else {
          continue;
        }
        if (ncredits > 0) settlement.payouts[pk] = (settlement.payouts[pk] || 0) + ncredits;
      }
    }
  }

  /* ── Vote decryption (ECDH P-256 + AES-GCM, dual-mode) ────────────── */

  function _getSubtle() {
    if (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.subtle) {
      return globalThis.crypto.subtle;
    }
    if (typeof require !== "undefined" && typeof module !== "undefined") {
      var nc = require("crypto");
      return nc.webcrypto && nc.webcrypto.subtle;
    }
    return null;
  }

  function _b64ToBuf(b64) {
    var s = String(b64).replace(/-/g, "+").replace(/_/g, "/");
    var pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    if (typeof Buffer !== "undefined") return Buffer.from(s + pad, "base64");
    var bin = atob(s + pad);
    var buf = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf;
  }

  function _bufToB64Url(buf) {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    var a = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var s = "";
    for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function _toUtf8(arr) {
    if (typeof Buffer !== "undefined") return Buffer.from(arr).toString("utf8");
    return new TextDecoder().decode(arr);
  }

  async function decryptVote(dBase64Url, pubKeyBase64, evBase64) {
    var subtle = _getSubtle();
    if (!subtle) throw new Error("WebCrypto subtle unavailable");
    var combined = _b64ToBuf(evBase64);
    var iv = combined.slice(0, 12);
    var ephPub = combined.slice(12, 77);
    var ct = combined.slice(77);
    var serverPubBuf = _b64ToBuf(pubKeyBase64);
    var x = _bufToB64Url(serverPubBuf.slice(1, 33));
    var y = _bufToB64Url(serverPubBuf.slice(33, 65));
    var privKey = await subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: x, y: y, d: dBase64Url },
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"]
    );
    var ephKey = await subtle.importKey(
      "raw", ephPub, { name: "ECDH", namedCurve: "P-256" }, false, []
    );
    var shared = await subtle.deriveBits({ name: "ECDH", public: ephKey }, privKey, 256);
    var aesKey = await subtle.importKey("raw", shared, { name: "AES-GCM" }, false, ["decrypt"]);
    var plain = await subtle.decrypt({ name: "AES-GCM", iv: iv }, aesKey, ct);
    return _toUtf8(new Uint8Array(plain));
  }

  /**
   * Decrypt vote ciphertexts in-place by replacing `memo.ev`+`memo.ki` with
   * `memo.choice`. Returns a new array of raw txs (txs without an encrypted
   * vote pass through unchanged). Idempotent; safe to call repeatedly.
   *
   * `cache` is an optional Map<tx_id, decrypted_tx> for client-side reuse
   * across refreshes. Decryption is the slowest part of rebuild on large
   * tx feeds.
   */
  async function decryptVoteMemos(rawTxs, appPubkey, cache) {
    var parseAppTx = makeParseAppTx(appPubkey);
    var PUBKEY_MAP = new Map();
    var PRIVKEY_MAP = new Map();
    for (var i = 0; i < rawTxs.length; i++) {
      var p = parseAppTx(rawTxs[i]);
      if (!p) continue;
      if (p.memo.type === "publish_pubkeys" && p.memo.keys && p.memo.survey) {
        var m = PUBKEY_MAP.get(p.memo.survey) || new Map();
        var entries = Object.entries(p.memo.keys);
        for (var j = 0; j < entries.length; j++) m.set(Number(entries[j][0]), entries[j][1]);
        PUBKEY_MAP.set(p.memo.survey, m);
      }
      if (p.memo.type === "reveal_key" && p.memo.survey != null && p.memo.ki != null && p.memo.d) {
        var pm = PRIVKEY_MAP.get(p.memo.survey) || new Map();
        pm.set(Number(p.memo.ki), p.memo.d);
        PRIVKEY_MAP.set(p.memo.survey, pm);
      }
    }
    var result = [];
    for (var k = 0; k < rawTxs.length; k++) {
      var raw = rawTxs[k];
      var txId = raw.tx_id || raw.id || raw.txid || raw.hash || null;
      if (cache && txId && cache.has(txId)) { result.push(cache.get(txId)); continue; }
      var pp = parseAppTx(raw);
      if (!pp || pp.memo.type !== "vote" || !pp.memo.ev || pp.memo.ki == null) {
        if (cache && txId) cache.set(txId, raw);
        result.push(raw);
        continue;
      }
      var surveyKeys = PRIVKEY_MAP.get(pp.memo.survey);
      var dScalar = surveyKeys ? surveyKeys.get(Number(pp.memo.ki)) : null;
      var pubMap = PUBKEY_MAP.get(pp.memo.survey);
      var pub = pubMap ? pubMap.get(Number(pp.memo.ki)) : null;
      if (!dScalar || !pub) { result.push(raw); continue; }
      try {
        var choice = await decryptVote(dScalar, pub, pp.memo.ev);
        var newMemo = Object.assign({}, pp.memo, { choice: choice });
        delete newMemo.ev;
        var newRaw = Object.assign({}, raw, { memo: JSON.stringify(newMemo) });
        if (cache && txId) cache.set(txId, newRaw);
        result.push(newRaw);
      } catch (e) {
        result.push(raw);
      }
    }
    return result;
  }

  /* ── Credit-balance accessors ─────────────────────────────────────── */

  /**
   * Liquid credit balance for `pubkey` given the rebuilt state.
   *
   * After `computeFullState` runs, every joined user has an initialized
   * `CREDIT_FLOWS` entry (this is enforced in Phase 2). The `if (!f)` branch
   * is defensive only — if it ever fires post-`computeFullState`, that's a
   * bug in this module, not a "user has no recorded activity" case.
   */
  function userBalance(state, pubkey) {
    if (!state || !pubkey || !state.JOINED || !state.JOINED.has(pubkey)) return 0;
    var f = state.CREDIT_FLOWS.get(pubkey);
    if (!f) {
      // Should be unreachable — Phase 2 initializes a flow for every join.
      // Falling through to INITIAL_CREDITS here would mask the structural
      // bug that bit maragung. Surface it instead.
      if (typeof console !== "undefined" && console.warn) {
        console.warn("[opinion-market-state] userBalance: joined user has no CREDIT_FLOWS entry — this is a bug:", pubkey);
      }
      return INITIAL_CREDITS;
    }
    return INITIAL_CREDITS - f.antes - f.grossBets + f.netSells + f.payouts + f.dividends + f.creatorRewards;
  }

  /**
   * Mark-to-market share value at current pool prices, summed across all
   * active surveys. Optional — the UI uses this for the leaderboard's
   * "total wealth" column. Not used in any validation check.
   */
  function userShareValue(state, pubkey) {
    var total = 0;
    for (var i = 0; i < state.SURVEYS.length; i++) {
      var survey = state.SURVEYS[i];
      if (survey.archived) continue;
      var mkt = state.MARKETS.get(survey.id);
      if (!mkt || !mkt.pools) continue;
      var keys = Object.keys(mkt.pools);
      if (keys.length === 0) continue;
      var isMulti = keys.length > 1;
      var yesHoldings = (mkt.userShares && mkt.userShares[pubkey]) || {};
      for (var j = 0; j < keys.length; j++) {
        var optKey = keys[j];
        var sh = yesHoldings[optKey] || 0;
        if (sh <= 0) continue;
        if (isMulti && CPMM.cpmmSellArbitrage) {
          total += CPMM.cpmmSellArbitrage(mkt.pools, optKey, sh).creditsReceived;
        } else if (CPMM.cpmmSellYes) {
          total += CPMM.cpmmSellYes(mkt.pools[optKey], sh);
        }
      }
      var noHoldings = (mkt.userNoShares && mkt.userNoShares[pubkey]) || {};
      for (var jj = 0; jj < keys.length; jj++) {
        var optK = keys[jj];
        var sh2 = noHoldings[optK] || 0;
        if (sh2 <= 0) continue;
        if (isMulti && CPMM.cpmmSellArbitrageNo) {
          total += CPMM.cpmmSellArbitrageNo(mkt.pools, optK, sh2).creditsReceived;
        } else if (CPMM.cpmmSellNo) {
          total += CPMM.cpmmSellNo(mkt.pools[optK], sh2);
        }
      }
    }
    return total;
  }

  /* ── Core: Phase 1-8 state rebuild ────────────────────────────────── */

  /**
   * Pure, deterministic rebuild of all OM state from a raw chain tx feed.
   *
   * Input:
   *   opts.rawTxs            — array of raw chain txs (newest-first or any
   *                            order; we sort chronologically internally).
   *   opts.appPubkey         — OM dapp address (recipient of every OM action).
   *   opts.adminPubkey       — explicit admin pubkey (or null → use first joiner).
   *   opts.genesisAccounts   — Set or array of pubkeys allowed to participate.
   *                            Empty → ungated (everyone can join/vote/bet).
   *   opts.globalUsernames   — { pubkey: name } from the global usernames cache.
   *                            Overrides any per-app `set_username` memos.
   *   opts.now               — ms timestamp used to mark surveys as archived.
   *   opts.decryptedTxs      — optional pre-decrypted tx array. If omitted, we
   *                            decrypt internally. Pass it to reuse the client's
   *                            decrypt cache and avoid redoing work.
   *   opts.decryptCache      — optional Map<tx_id, tx> used when we decrypt
   *                            internally. Same cache the UI uses.
   *
   * Output: a `state` object with these fields. Treat as read-only after
   *   construction:
   *     SURVEYS              — array, newest-first
   *     SURVEYS_BY_ID        — Map<id, survey>
   *     MARKETS              — Map<surveyId, market>
   *     JOINED               — Set<pubkey>
   *     GLOBAL_USERNAMES     — Map<pubkey, name>
   *     CREDIT_FLOWS         — Map<pubkey, { antes, grossBets, netSells, payouts, dividends, creatorRewards }>
   *     SETTLEMENTS          — Map<surveyId, settlement>
   *     voteMap              — Map<"pubkey:surveyId", { from, survey, choice, ts }>
   *     firstJoiner          — pubkey (or null)
   *     earningsMap          — Map<pubkey, { totalEarnings, marketsParticipated, marketsWon }>
   *     parsedTxs            — chronologically-sorted [{ tx, memo }] for downstream UI use
   *     decryptedTxs         — the (possibly-decrypted) tx feed; pass back next round
   */
  async function computeFullState(opts) {
    var appPubkey = opts.appPubkey;
    var adminPubkey = opts.adminPubkey || null;
    var genesisAccounts = opts.genesisAccounts instanceof Set
      ? opts.genesisAccounts
      : new Set(Array.isArray(opts.genesisAccounts) ? opts.genesisAccounts : []);
    var globalUsernames = opts.globalUsernames || {};
    var now = typeof opts.now === "number" ? opts.now : Date.now();

    var isGenesisGated = genesisAccounts.size > 0;
    function isGenesisAccount(addr) { return !isGenesisGated || genesisAccounts.has(addr); }

    var parseAppTx = makeParseAppTx(appPubkey);

    var decryptedTxs = opts.decryptedTxs;
    if (!decryptedTxs) {
      decryptedTxs = await decryptVoteMemos(opts.rawTxs || [], appPubkey, opts.decryptCache || null);
    }

    var parsed = [];
    for (var i = 0; i < decryptedTxs.length; i++) {
      var p = parseAppTx(decryptedTxs[i]);
      if (p) parsed.push(p);
    }
    parsed.sort(function (a, b) { return a.tx.ts - b.tx.ts; });

    var GLOBAL_USERNAMES = new Map();
    var JOINED = new Set();
    var MARKETS = new Map();
    var SETTLEMENTS = new Map();
    var CREDIT_FLOWS = new Map();
    // Every place_bet / sell_shares that Phase 6 rejects gets a record
    // here so callers can show "your bet was dropped because X" UI without
    // having to re-derive Phase 6 logic.
    var REJECTED_SENDS = [];
    function recordReject(P, reason, extra) {
      var rec = {
        ts: P.tx.ts,
        txId: P.tx.id,
        from: P.tx.from,
        type: P.memo.type,
        surveyId: P.memo.survey == null ? null : String(P.memo.survey),
        optionKey: P.memo.option == null ? null : String(P.memo.option),
        side: P.memo.side === "no" ? "no" : "yes",
        credits: P.memo.credits,
        shares: P.memo.shares,
        reason: reason,
      };
      if (extra) for (var k in extra) rec[k] = extra[k];
      REJECTED_SENDS.push(rec);
    }

    function getCreditFlow(pubkey) {
      var f = CREDIT_FLOWS.get(pubkey);
      if (!f) {
        f = { antes: 0, grossBets: 0, netSells: 0, payouts: 0, dividends: 0, creatorRewards: 0 };
        CREDIT_FLOWS.set(pubkey, f);
      }
      return f;
    }

    function localUserBalance(pubkey) {
      if (!JOINED.has(pubkey)) return 0;
      var f = CREDIT_FLOWS.get(pubkey);
      if (!f) return INITIAL_CREDITS;
      return INITIAL_CREDITS - f.antes - f.grossBets + f.netSells + f.payouts + f.dividends + f.creatorRewards;
    }

    /* --- Phase 1: Usernames --- */
    var nameMap = new Map();
    for (var ix1 = 0; ix1 < parsed.length; ix1++) {
      var P = parsed[ix1];
      if (P.memo.type !== "set_username") continue;
      var prev = nameMap.get(P.tx.from);
      if (!prev || P.tx.ts >= prev.ts) {
        nameMap.set(P.tx.from, {
          name: normalizeUsername(P.memo.username, deriveDefaultUsername(P.tx.from), P.tx.from),
          ts: P.tx.ts,
        });
      }
    }
    var nmEntries = Array.from(nameMap.entries());
    for (var ix2 = 0; ix2 < nmEntries.length; ix2++) {
      GLOBAL_USERNAMES.set(nmEntries[ix2][0], nmEntries[ix2][1].name);
    }
    // Global identity names take precedence over legacy per-app names.
    var gnKeys = Object.keys(globalUsernames);
    for (var gi = 0; gi < gnKeys.length; gi++) {
      GLOBAL_USERNAMES.set(gnKeys[gi], globalUsernames[gnKeys[gi]]);
    }

    /* --- Phase 2: Joins --- */
    var firstJoiner = null;
    var firstJoinTs = Infinity;
    for (var ix3 = 0; ix3 < parsed.length; ix3++) {
      var P3 = parsed[ix3];
      if (P3.memo.type !== "join" || !isGenesisAccount(P3.tx.from)) continue;
      JOINED.add(P3.tx.from);
      if (P3.tx.ts < firstJoinTs) { firstJoinTs = P3.tx.ts; firstJoiner = P3.tx.from; }
    }

    // Initialize a CREDIT_FLOWS entry for every joined user. Without this,
    // `userBalance` for a user who has done nothing but join falls into a
    // `!f` branch and reports `INITIAL_CREDITS` — which historically masked
    // bugs where the rebuild silently dropped a user's bets (see maragung
    // case, May 2026). With this initialization, the `!f` fallback in
    // `userBalance` is unreachable post-Phase 2, and "no flow entry"
    // becomes a loud bug instead of a quiet wrong-answer.
    var joinedArr = Array.from(JOINED);
    for (var ji = 0; ji < joinedArr.length; ji++) getCreditFlow(joinedArr[ji]);

    /* --- Phase 3: Surveys (admin-only, rate-limited, with delete/resolve_early) --- */
    var effectiveAdmin = adminPubkey || firstJoiner;
    var allCreations = [];
    for (var ix4 = 0; ix4 < parsed.length; ix4++) {
      var P4 = parsed[ix4];
      if (P4.memo.type !== "create_survey") continue;
      if (!isGenesisAccount(P4.tx.from)) continue;
      if (effectiveAdmin && P4.tx.from !== effectiveAdmin) continue;
      var sv = normalizeSurveyDefinition(P4.memo.survey);
      if (sv) allCreations.push({ survey: sv, ts: P4.tx.ts, from: P4.tx.from });
    }
    allCreations.sort(function (a, b) { return a.ts - b.ts; });
    var creationsBySender = new Map();
    var latestCreated = new Map();
    for (var ic = 0; ic < allCreations.length; ic++) {
      var entry = allCreations[ic];
      var times = creationsBySender.get(entry.from) || [];
      var windowStart = entry.ts - SURVEY_COOLDOWN_MS;
      var recent = times.filter(function (t) { return t > windowStart; });
      if (recent.length >= MAX_SURVEYS_PER_WINDOW) continue;
      recent.push(entry.ts);
      creationsBySender.set(entry.from, recent);
      var existing = latestCreated.get(entry.survey.id);
      if (!existing || entry.ts >= existing.ts) {
        latestCreated.set(entry.survey.id, { survey: entry.survey, ts: entry.ts, from: entry.from });
      }
    }
    var earlyResolves = new Map();
    for (var ie = 0; ie < parsed.length; ie++) {
      var Pe = parsed[ie];
      if (Pe.memo.type !== "resolve_early") continue;
      var svE = Pe.memo.survey == null ? null : String(Pe.memo.survey);
      if (!svE) continue;
      var prevE = earlyResolves.get(svE);
      if (!prevE || Pe.tx.ts < prevE) earlyResolves.set(svE, Pe.tx.ts);
    }
    var deletedSurveyIds = new Set();
    for (var idd = 0; idd < parsed.length; idd++) {
      var Pd = parsed[idd];
      if (Pd.memo.type !== "delete_survey") continue;
      var svD = Pd.memo.survey == null ? null : String(Pd.memo.survey);
      if (!svD) continue;
      var isAdminSender = adminPubkey
        ? Pd.tx.from === adminPubkey
        : !!firstJoiner && Pd.tx.from === firstJoiner;
      if (isAdminSender) deletedSurveyIds.add(svD);
    }

    var SURVEYS = Array.from(latestCreated.values())
      .filter(function (x) { return !deletedSurveyIds.has(x.survey.id); })
      .sort(function (a, b) { return b.ts - a.ts; })
      .map(function (x) {
        var expiresAtMs = x.ts + x.survey.activeDurationMs;
        var earlyResolve = earlyResolves.get(x.survey.id);
        if (earlyResolve && earlyResolve < expiresAtMs) expiresAtMs = earlyResolve;
        return Object.assign({}, x.survey, {
          createdBy: x.from,
          createdAtMs: x.ts,
          expiresAtMs: expiresAtMs,
          archived: now >= expiresAtMs,
        });
      });
    var SURVEYS_BY_ID = new Map();
    for (var si = 0; si < SURVEYS.length; si++) SURVEYS_BY_ID.set(SURVEYS[si].id, SURVEYS[si]);

    /* --- Phase 4: Custom options per survey --- */
    var optionsBySurvey = new Map();
    for (var ix5 = 0; ix5 < parsed.length; ix5++) {
      var P5 = parsed[ix5];
      if (P5.memo.type !== "add_option") continue;
      if (!isGenesisAccount(P5.tx.from)) continue;
      var sv5 = P5.memo.survey == null ? null : String(P5.memo.survey);
      var survey5 = SURVEYS_BY_ID.get(sv5);
      if (!survey5 || !survey5.allowCustomOptions) continue;
      if (survey5.archived && P5.tx.ts >= survey5.expiresAtMs) continue;
      var optObj = P5.memo.option && typeof P5.memo.option === "object" ? P5.memo.option : null;
      var label5 = optObj && optObj.label != null ? String(optObj.label).trim() : "";
      if (!label5) continue;
      var key5 = (optObj && optObj.key != null ? String(optObj.key).trim() : slugify(label5)) || ("opt_" + last6(P5.tx.from) + "_" + String(P5.tx.ts));
      if (!optionsBySurvey.has(sv5)) optionsBySurvey.set(sv5, new Map());
      var senderMap = optionsBySurvey.get(sv5);
      var prev5 = senderMap.get(P5.tx.from);
      if (!prev5 || P5.tx.ts < prev5.ts) {
        senderMap.set(P5.tx.from, { key: key5, label: label5, ts: P5.tx.ts, from: P5.tx.from });
      }
    }
    for (var ss = 0; ss < SURVEYS.length; ss++) {
      var sv6 = SURVEYS[ss];
      var smap = optionsBySurvey.get(sv6.id);
      if (!smap) continue;
      var existingMap = new Map(sv6.options.map(function (o) { return [o.key, o]; }));
      var added = Array.from(smap.values()).sort(function (a, b) { return a.ts - b.ts; });
      for (var ai = 0; ai < added.length; ai++) {
        var it = added[ai];
        var keyA = it.key;
        if (existingMap.has(keyA)) keyA = keyA + "_" + last6(it.from);
        if (existingMap.has(keyA)) keyA = keyA + "_" + String(it.ts).slice(-4);
        existingMap.set(keyA, { key: keyA, label: it.label, userAdded: true, addedBy: it.from });
      }
      sv6.options = Array.from(existingMap.values());
    }

    /* --- Phase 5: Votes (latest per sender per survey) --- */
    var voteMap = new Map();
    for (var ix6 = 0; ix6 < parsed.length; ix6++) {
      var Pv = parsed[ix6];
      if (Pv.memo.type !== "vote") continue;
      if (!isGenesisAccount(Pv.tx.from)) continue;
      var svV = Pv.memo.survey == null ? null : String(Pv.memo.survey);
      var surveyV = SURVEYS_BY_ID.get(svV);
      if (!surveyV) continue;
      var ch = Pv.memo.choice != null ? String(Pv.memo.choice) : Pv.memo.vote != null ? String(Pv.memo.vote) : null;
      if (!ch || !surveyV.options.some(function (o) { return o.key === ch; })) continue;
      var vkey = Pv.tx.from + ":" + svV;
      var prevV = voteMap.get(vkey);
      if (!prevV || Pv.tx.ts >= prevV.ts) {
        voteMap.set(vkey, { from: Pv.tx.from, survey: svV, choice: ch, ts: Pv.tx.ts });
      }
    }

    /* --- Phase 5b: Seed markets from creator ante --- */
    for (var sb = 0; sb < SURVEYS.length; sb++) {
      var sv7 = SURVEYS[sb];
      if (!sv7.createdBy || !JOINED.has(sv7.createdBy)) continue;
      if (localUserBalance(sv7.createdBy) < MARKET_ANTE) continue;
      var numOpts = sv7.options.length;
      if (numOpts < 2) continue;
      var initPools = CPMM.cpmmInitPools ? CPMM.cpmmInitPools(MARKET_ANTE + PLATFORM_LIQUIDITY, numOpts) : [];
      if (initPools.length === 0) continue;
      var mkt = {
        pools: {}, userShares: {}, userNoShares: {}, feePool: 0,
        grossBetsByUser: {}, netSellsByUser: {}, creatorReward: 0,
        creator: sv7.createdBy, history: [], optionVolume: {},
      };
      var seedPerOption = (MARKET_ANTE + PLATFORM_LIQUIDITY) / sv7.options.length;
      for (var oi = 0; oi < sv7.options.length; oi++) {
        mkt.pools[sv7.options[oi].key] = Object.assign({}, initPools[oi]);
        mkt.optionVolume[sv7.options[oi].key] = seedPerOption;
      }
      var initProbs = {};
      for (var op = 0; op < sv7.options.length; op++) {
        initProbs[sv7.options[op].key] = CPMM.cpmmProb ? CPMM.cpmmProb(mkt.pools[sv7.options[op].key]) : 0;
      }
      mkt.history.push({ ts: sv7.createdAtMs, probs: initProbs });
      MARKETS.set(sv7.id, mkt);
      getCreditFlow(sv7.createdBy).antes += MARKET_ANTE;
    }

    /* --- Phase 6: Market operations (chronological replay) ---
     *
     * Every silent rejection here also gets logged to REJECTED_SENDS so
     * the UI can surface "your bet was dropped because X" feedback to
     * the user. Without this, users pay the 1-token tx fee for every
     * dropped bet and get no signal — which is how scraido (May 2026)
     * burned ~14 fees with no UI feedback. */
    for (var ix7 = 0; ix7 < parsed.length; ix7++) {
      var Pm = parsed[ix7];
      if (Pm.memo.type !== "place_bet" && Pm.memo.type !== "sell_shares") continue;
      var svM = Pm.memo.survey == null ? null : String(Pm.memo.survey);
      var surveyM = SURVEYS_BY_ID.get(svM);
      if (!surveyM) { recordReject(Pm, "NO_SURVEY"); continue; }
      if (Pm.tx.ts >= surveyM.expiresAtMs) { recordReject(Pm, "EXPIRED"); continue; }
      var optKey = Pm.memo.option == null ? null : String(Pm.memo.option);
      if (!optKey || !surveyM.options.some(function (o) { return o.key === optKey; })) {
        recordReject(Pm, "NO_OPTION");
        continue;
      }
      if (!JOINED.has(Pm.tx.from)) { recordReject(Pm, "NOT_JOINED"); continue; }

      var mkt2 = MARKETS.get(svM);
      if (!mkt2) {
        var n2 = surveyM.options.length;
        var initPools2 = CPMM.cpmmInitPools ? CPMM.cpmmInitPools(MARKET_ANTE + PLATFORM_LIQUIDITY, n2) : [];
        mkt2 = {
          pools: {}, userShares: {}, userNoShares: {}, feePool: 0,
          grossBetsByUser: {}, netSellsByUser: {}, creatorReward: 0,
          creator: surveyM.createdBy || null, history: [], optionVolume: {},
        };
        if (initPools2.length === n2) {
          var spo = (MARKET_ANTE + PLATFORM_LIQUIDITY) / n2;
          for (var ii2 = 0; ii2 < n2; ii2++) {
            mkt2.pools[surveyM.options[ii2].key] = Object.assign({}, initPools2[ii2]);
            mkt2.optionVolume[surveyM.options[ii2].key] = spo;
          }
          var ip = {};
          for (var oo = 0; oo < surveyM.options.length; oo++) {
            ip[surveyM.options[oo].key] = CPMM.cpmmProb ? CPMM.cpmmProb(mkt2.pools[surveyM.options[oo].key]) : 0;
          }
          mkt2.history.push({ ts: surveyM.createdAtMs, probs: ip });
        }
        MARKETS.set(svM, mkt2);
      }

      if (Pm.memo.type === "place_bet") {
        var credits = typeof Pm.memo.credits === "number" ? Pm.memo.credits : Number(Pm.memo.credits);
        if (!Number.isFinite(credits) || credits < 1) { recordReject(Pm, "BAD_CREDITS"); continue; }
        var bal = localUserBalance(Pm.tx.from);
        if (bal < credits) { recordReject(Pm, "INSUFFICIENT_BALANCE", { balance: bal, needed: credits }); continue; }
        var totalPoolValue = Object.values(mkt2.pools).reduce(function (s, pp) { return s + pp.yes + pp.no; }, 0);
        var maxBet = Math.floor(totalPoolValue * MAX_BET_POOL_RATIO);
        if (credits > maxBet) { recordReject(Pm, "OVER_MAX_BET", { maxBet: maxBet, poolTotal: totalPoolValue }); continue; }

        var fee = credits * FEE_RATE;
        var liquidityFee = credits * LIQUIDITY_FEE_RATE;
        var creatorCut = Math.min(credits * CREATOR_REWARD_RATE, CREATOR_REWARD_CAP - mkt2.creatorReward);
        var voterFee = fee - Math.max(0, creatorCut) - liquidityFee;
        var net = credits - fee;

        var side = Pm.memo.side === "no" ? "no" : "yes";
        var pool = mkt2.pools[optKey];
        if (!pool) { recordReject(Pm, "NO_POOL"); continue; }

        var res;
        if (side === "no") {
          if (!CPMM.cpmmArbitrageNo) { recordReject(Pm, "CPMM_UNAVAILABLE"); continue; }
          res = CPMM.cpmmArbitrageNo(mkt2.pools, optKey, net);
        } else {
          if (!CPMM.cpmmArbitrage) { recordReject(Pm, "CPMM_UNAVAILABLE"); continue; }
          res = CPMM.cpmmArbitrage(mkt2.pools, optKey, net);
        }
        if (res.sharesReceived <= 0) { recordReject(Pm, "ZERO_SHARES"); continue; }

        var npKeys2 = Object.keys(res.newPools);
        for (var npi = 0; npi < npKeys2.length; npi++) mkt2.pools[npKeys2[npi]] = res.newPools[npKeys2[npi]];
        addPoolLiquidity(mkt2.pools, liquidityFee);
        if (side === "no") {
          if (!mkt2.userNoShares[Pm.tx.from]) mkt2.userNoShares[Pm.tx.from] = {};
          mkt2.userNoShares[Pm.tx.from][optKey] = (mkt2.userNoShares[Pm.tx.from][optKey] || 0) + res.sharesReceived;
        } else {
          if (!mkt2.userShares[Pm.tx.from]) mkt2.userShares[Pm.tx.from] = {};
          mkt2.userShares[Pm.tx.from][optKey] = (mkt2.userShares[Pm.tx.from][optKey] || 0) + res.sharesReceived;
        }
        mkt2.feePool += voterFee;
        if (creatorCut > 0) {
          mkt2.creatorReward += creatorCut;
          if (mkt2.creator) getCreditFlow(mkt2.creator).creatorRewards += creatorCut;
        }
        mkt2.grossBetsByUser[Pm.tx.from] = (mkt2.grossBetsByUser[Pm.tx.from] || 0) + credits;
        getCreditFlow(Pm.tx.from).grossBets += credits;
        mkt2.optionVolume[optKey] = (mkt2.optionVolume[optKey] || 0) + credits;
        var hp = {};
        var poolKeys = Object.keys(mkt2.pools);
        for (var hk = 0; hk < poolKeys.length; hk++) hp[poolKeys[hk]] = CPMM.cpmmProb ? CPMM.cpmmProb(mkt2.pools[poolKeys[hk]]) : 0;
        mkt2.history.push({ ts: Pm.tx.ts, probs: hp });
      }

      if (Pm.memo.type === "sell_shares") {
        var sharesToSell = typeof Pm.memo.shares === "number" ? Pm.memo.shares : Number(Pm.memo.shares);
        if (!Number.isFinite(sharesToSell) || sharesToSell <= 0) { recordReject(Pm, "BAD_SHARES"); continue; }
        var sideS = Pm.memo.side === "no" ? "no" : "yes";
        var userHeld = sideS === "no"
          ? ((mkt2.userNoShares[Pm.tx.from] && mkt2.userNoShares[Pm.tx.from][optKey]) || 0)
          : ((mkt2.userShares[Pm.tx.from] && mkt2.userShares[Pm.tx.from][optKey]) || 0);
        if (userHeld < sharesToSell) { recordReject(Pm, "INSUFFICIENT_SHARES", { held: userHeld, needed: sharesToSell }); continue; }
        var poolS = mkt2.pools[optKey];
        if (!poolS) { recordReject(Pm, "NO_POOL"); continue; }

        var grossCredits;
        if (sideS === "no") {
          if (CPMM.cpmmSellArbitrageNo && Object.keys(mkt2.pools).length > 1) {
            var resultS = CPMM.cpmmSellArbitrageNo(mkt2.pools, optKey, sharesToSell);
            grossCredits = resultS.creditsReceived;
            if (grossCredits <= 0) continue;
            var spKeys = Object.keys(resultS.newPools);
            for (var spi = 0; spi < spKeys.length; spi++) mkt2.pools[spKeys[spi]] = resultS.newPools[spKeys[spi]];
          } else if (CPMM.cpmmSellNo && CPMM.cpmmSellNoApply) {
            grossCredits = CPMM.cpmmSellNo(poolS, sharesToSell);
            if (grossCredits <= 0) continue;
            mkt2.pools[optKey] = CPMM.cpmmSellNoApply(poolS, sharesToSell);
          } else {
            continue;
          }
        } else {
          if (CPMM.cpmmSellArbitrage && Object.keys(mkt2.pools).length > 1) {
            var resultY = CPMM.cpmmSellArbitrage(mkt2.pools, optKey, sharesToSell);
            grossCredits = resultY.creditsReceived;
            if (grossCredits <= 0) continue;
            var syKeys = Object.keys(resultY.newPools);
            for (var syi = 0; syi < syKeys.length; syi++) mkt2.pools[syKeys[syi]] = resultY.newPools[syKeys[syi]];
          } else if (CPMM.cpmmSellYes && CPMM.cpmmSellYesApply) {
            grossCredits = CPMM.cpmmSellYes(poolS, sharesToSell);
            if (grossCredits <= 0) continue;
            mkt2.pools[optKey] = CPMM.cpmmSellYesApply(poolS, sharesToSell);
          } else {
            continue;
          }
        }

        var feeS = grossCredits * FEE_RATE;
        var liquidityFeeS = grossCredits * LIQUIDITY_FEE_RATE;
        var creatorCutS = Math.min(grossCredits * CREATOR_REWARD_RATE, CREATOR_REWARD_CAP - mkt2.creatorReward);
        var voterFeeS = feeS - Math.max(0, creatorCutS) - liquidityFeeS;
        var netCredits = grossCredits - feeS;

        addPoolLiquidity(mkt2.pools, liquidityFeeS);
        if (sideS === "no") {
          mkt2.userNoShares[Pm.tx.from][optKey] = userHeld - sharesToSell;
        } else {
          mkt2.userShares[Pm.tx.from][optKey] = userHeld - sharesToSell;
        }
        mkt2.feePool += voterFeeS;
        if (creatorCutS > 0) {
          mkt2.creatorReward += creatorCutS;
          if (mkt2.creator) getCreditFlow(mkt2.creator).creatorRewards += creatorCutS;
        }
        mkt2.netSellsByUser[Pm.tx.from] = (mkt2.netSellsByUser[Pm.tx.from] || 0) + netCredits;
        getCreditFlow(Pm.tx.from).netSells += netCredits;
        var sp = {};
        var poolKeysS = Object.keys(mkt2.pools);
        for (var spk = 0; spk < poolKeysS.length; spk++) sp[poolKeysS[spk]] = CPMM.cpmmProb ? CPMM.cpmmProb(mkt2.pools[poolKeysS[spk]]) : 0;
        mkt2.history.push({ ts: Pm.tx.ts, probs: sp });
      }
    }

    /* --- Phase 7: Settlement for expired surveys --- */
    for (var stx = 0; stx < SURVEYS.length; stx++) {
      var sv8 = SURVEYS[stx];
      if (!sv8.archived) continue;
      var mkt3 = MARKETS.get(sv8.id);

      var voteCounts = {};
      for (var vo = 0; vo < sv8.options.length; vo++) voteCounts[sv8.options[vo].key] = 0;
      var voterSet = new Set();
      var vmEntries = Array.from(voteMap.entries());
      for (var ve = 0; ve < vmEntries.length; ve++) {
        var v = vmEntries[ve][1];
        if (v.survey !== sv8.id) continue;
        voteCounts[v.choice] = (voteCounts[v.choice] || 0) + 1;
        voterSet.add(v.from);
      }

      var totalPool = mkt3 ? cpmmTotalLiquidity(mkt3) : 0;
      var settlement = {
        winner: null, payouts: {}, voterDividendPer: 0, surprise: {},
        totalPool: totalPool, feePool: mkt3 ? mkt3.feePool : 0,
        voteCounts: voteCounts, voterCount: voterSet.size, voters: voterSet,
      };

      if (mkt3 && totalPool > 0) {
        settlement.feePool = mkt3.feePool;
        var totalVotes = Object.values(voteCounts).reduce(function (a, b) { return a + b; }, 0);

        for (var soi = 0; soi < sv8.options.length; soi++) {
          var vs = totalVotes > 0 ? (voteCounts[sv8.options[soi].key] || 0) / totalVotes : 0;
          var pool8 = mkt3.pools[sv8.options[soi].key];
          var mp = pool8 && CPMM.cpmmProb ? CPMM.cpmmProb(pool8) : 0;
          settlement.surprise[sv8.options[soi].key] = vs - mp;
        }

        if (totalVotes === 0) {
          distributeRefund(mkt3, settlement);
        } else {
          var maxVotes = 0;
          var winners = [];
          var vcEntries = Object.entries(voteCounts);
          for (var vci = 0; vci < vcEntries.length; vci++) {
            var key = vcEntries[vci][0];
            var count = vcEntries[vci][1];
            if (count > maxVotes) { maxVotes = count; winners = [key]; }
            else if (count === maxVotes && count > 0) winners.push(key);
          }
          var K = winners.length;
          settlement.winners = winners;
          settlement.winner = K === 1 ? winners[0] : null;
          var weights = {};
          for (var owi = 0; owi < sv8.options.length; owi++) weights[sv8.options[owi].key] = 0;
          for (var wi = 0; wi < winners.length; wi++) weights[winners[wi]] = 1 / K;
          settlement.resolutionWeights = weights;

          var ysEntries = Object.entries(mkt3.userShares);
          for (var ysi = 0; ysi < ysEntries.length; ysi++) {
            var pkY = ysEntries[ysi][0];
            var sharesY = ysEntries[ysi][1];
            var sEntries = Object.entries(sharesY);
            for (var ssi = 0; ssi < sEntries.length; ssi++) {
              var optK2 = sEntries[ssi][0];
              var sV = sEntries[ssi][1];
              var w = weights[optK2] || 0;
              if (w > 0 && sV > 0) settlement.payouts[pkY] = (settlement.payouts[pkY] || 0) + sV * w;
            }
          }
          var nsEntries = Object.entries(mkt3.userNoShares || {});
          for (var nsi = 0; nsi < nsEntries.length; nsi++) {
            var pkN = nsEntries[nsi][0];
            var noShares = nsEntries[nsi][1];
            var nEntries = Object.entries(noShares);
            for (var nei = 0; nei < nEntries.length; nei++) {
              var optK3 = nEntries[nei][0];
              var ns = nEntries[nei][1];
              if (ns <= 0) continue;
              var wN = weights[optK3] || 0;
              var noPayout = (1 - wN) * ns;
              if (noPayout > 0) settlement.payouts[pkN] = (settlement.payouts[pkN] || 0) + noPayout;
            }
          }
        }

        if (voterSet.size > 0 && mkt3.feePool > 0) {
          settlement.voterDividendPer = mkt3.feePool / voterSet.size;
        }

        var poEntries = Object.entries(settlement.payouts);
        for (var poi = 0; poi < poEntries.length; poi++) {
          getCreditFlow(poEntries[poi][0]).payouts += poEntries[poi][1];
        }
        if (settlement.voterDividendPer > 0) {
          var vsArr = Array.from(voterSet);
          for (var vsi = 0; vsi < vsArr.length; vsi++) {
            getCreditFlow(vsArr[vsi]).dividends += settlement.voterDividendPer;
          }
        }
      }

      SETTLEMENTS.set(sv8.id, settlement);
    }

    /* --- Phase 8: Earnings (Bet P&L) per archived market --- */
    var earningsMap = new Map();
    for (var ei = 0; ei < SURVEYS.length; ei++) {
      var sv9 = SURVEYS[ei];
      if (!sv9.archived) continue;
      var mkt4 = MARKETS.get(sv9.id);
      if (!mkt4 || cpmmTotalLiquidity(mkt4) <= 0) continue;
      var settlement9 = SETTLEMENTS.get(sv9.id);
      if (!settlement9) continue;
      var dividend = settlement9.voterDividendPer || 0;
      var gbKeys = Object.keys(mkt4.grossBetsByUser);
      for (var gbi = 0; gbi < gbKeys.length; gbi++) {
        var pubkey = gbKeys[gbi];
        var grossBet = mkt4.grossBetsByUser[pubkey] || 0;
        if (grossBet <= 0) continue;
        var netSells = mkt4.netSellsByUser[pubkey] || 0;
        var payout = settlement9.payouts[pubkey] || 0;
        var div = (settlement9.voterCount > 0 && voteMap.has(pubkey + ":" + sv9.id)) ? dividend : 0;
        var profit = payout + netSells + div - grossBet;
        var shares9 = mkt4.userShares[pubkey] || {};
        var noShares9 = (mkt4.userNoShares || {})[pubkey] || {};
        var sw = settlement9.resolutionWeights || {};
        var hadWinningYes = Object.entries(shares9).some(function (e) { return e[1] > 0 && (sw[e[0]] || 0) > 0; });
        var hadWinningNo = Object.entries(noShares9).some(function (e) { return e[1] > 0 && (sw[e[0]] || 0) < 1; });
        var hadWinningShares = hadWinningYes || hadWinningNo;
        var ent = earningsMap.get(pubkey);
        if (!ent) { ent = { totalEarnings: 0, marketsParticipated: 0, marketsWon: 0 }; earningsMap.set(pubkey, ent); }
        ent.marketsParticipated++;
        ent.totalEarnings += profit;
        if (hadWinningShares && payout > 0) ent.marketsWon++;
      }
    }

    return {
      SURVEYS: SURVEYS,
      SURVEYS_BY_ID: SURVEYS_BY_ID,
      MARKETS: MARKETS,
      JOINED: JOINED,
      GLOBAL_USERNAMES: GLOBAL_USERNAMES,
      CREDIT_FLOWS: CREDIT_FLOWS,
      SETTLEMENTS: SETTLEMENTS,
      voteMap: voteMap,
      firstJoiner: firstJoiner,
      earningsMap: earningsMap,
      rejectedSends: REJECTED_SENDS,
      parsedTxs: parsed,
      decryptedTxs: decryptedTxs,
    };
  }

  /* ── Bet validation (preflight) ───────────────────────────────────── */

  /**
   * Apply the same validation that Phase 6 would apply to a hypothetical
   * `place_bet`. Returns `{ ok: true }` or `{ ok: false, reason, ... }`.
   *
   * The client should use this BEFORE handing a bet to `sendTransaction` —
   * a `false` answer means the bet would be silently dropped by every
   * subsequent state rebuild, so don't even pay the on-chain 1-token fee.
   *
   * IMPORTANT: this enforces the SAME rules as `computeFullState` Phase 6.
   * Any drift between this function and Phase 6 is a bug.
   */
  function validatePlaceBet(state, params) {
    var pubkey = params.pubkey;
    var surveyId = params.surveyId;
    var optionKey = params.optionKey;
    var credits = typeof params.credits === "number" ? params.credits : Number(params.credits);
    var side = params.side === "no" ? "no" : "yes";

    if (!state || !state.SURVEYS_BY_ID) return { ok: false, reason: "NO_STATE" };
    if (!pubkey) return { ok: false, reason: "NO_PUBKEY" };
    if (!state.JOINED.has(pubkey)) return { ok: false, reason: "NOT_JOINED" };
    var survey = state.SURVEYS_BY_ID.get(surveyId);
    if (!survey) return { ok: false, reason: "NO_SURVEY" };
    if (survey.archived) return { ok: false, reason: "ARCHIVED" };
    if (!survey.options.some(function (o) { return o.key === optionKey; })) return { ok: false, reason: "NO_OPTION" };
    if (!Number.isFinite(credits) || credits < 1) return { ok: false, reason: "BAD_CREDITS" };

    var bal = userBalance(state, pubkey);
    if (bal < credits) return { ok: false, reason: "INSUFFICIENT_BALANCE", balance: bal, needed: credits };

    var mkt = state.MARKETS.get(surveyId);
    if (!mkt) return { ok: false, reason: "NO_MARKET" };
    var totalPool = cpmmTotalLiquidity(mkt);
    var maxBet = Math.floor(totalPool * MAX_BET_POOL_RATIO);
    if (credits > maxBet) return { ok: false, reason: "OVER_MAX_BET", maxBet: maxBet, attempted: credits };
    if (side === "no" ? !CPMM.cpmmArbitrageNo : !CPMM.cpmmArbitrage) {
      return { ok: false, reason: "CPMM_UNAVAILABLE" };
    }
    return { ok: true };
  }

  /* ── Rejected-bet introspection (UX banner support) ───────────────── */

  /**
   * Filter the state's `rejectedSends` array to a single user. This is
   * the precise per-tx rejection list — every `place_bet`/`sell_shares`
   * tx that Phase 6 dropped, with the exact reason it gave at the moment
   * of replay (balance, pool, expiration, etc).
   *
   * Use this in the client to surface "your X-credit bet on Y was rejected
   * because Z" banners. Without this, silently-rejected bets cost the
   * user 1 token per attempt with zero feedback, which is how scraido and
   * maragung lost tens of tokens before anyone noticed.
   */
  function findRejectedSends(state, opts) {
    var pubkey = opts.pubkey;
    var rejected = state.rejectedSends || [];
    var out = [];
    for (var i = 0; i < rejected.length; i++) {
      if (rejected[i].from === pubkey) out.push(rejected[i]);
    }
    return out;
  }

  var api = {
    // Constants
    INITIAL_CREDITS: INITIAL_CREDITS,
    FEE_RATE: FEE_RATE,
    LIQUIDITY_FEE_RATE: LIQUIDITY_FEE_RATE,
    MARKET_ANTE: MARKET_ANTE,
    PLATFORM_LIQUIDITY: PLATFORM_LIQUIDITY,
    CREATOR_REWARD_RATE: CREATOR_REWARD_RATE,
    CREATOR_REWARD_CAP: CREATOR_REWARD_CAP,
    MAX_BET_POOL_RATIO: MAX_BET_POOL_RATIO,
    SURVEY_COOLDOWN_MS: SURVEY_COOLDOWN_MS,
    MAX_SURVEYS_PER_WINDOW: MAX_SURVEYS_PER_WINDOW,
    DEFAULT_SURVEY_DURATION_MS: DEFAULT_SURVEY_DURATION_MS,
    ALLOWED_SURVEY_DURATION_MS: ALLOWED_SURVEY_DURATION_MS,
    ALLOWED_REVEAL_INTERVALS: ALLOWED_REVEAL_INTERVALS,

    // Pure helpers
    parseMemo: parseMemo,
    normalizeTx: normalizeTx,
    makeParseAppTx: makeParseAppTx,
    slugify: slugify,
    last6: last6,
    usernameSuffix: usernameSuffix,
    deriveDefaultUsername: deriveDefaultUsername,
    normalizeUsername: normalizeUsername,
    normalizeSurveyDurationMs: normalizeSurveyDurationMs,
    normalizeSurveyDefinition: normalizeSurveyDefinition,
    getRevealCheckpoints: getRevealCheckpoints,
    cpmmTotalLiquidity: cpmmTotalLiquidity,
    addPoolLiquidity: addPoolLiquidity,
    distributeRefund: distributeRefund,

    // Decryption
    decryptVote: decryptVote,
    decryptVoteMemos: decryptVoteMemos,

    // Core
    computeFullState: computeFullState,
    userBalance: userBalance,
    userShareValue: userShareValue,
    validatePlaceBet: validatePlaceBet,
    findRejectedSends: findRejectedSends,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.OpinionMarketState = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
