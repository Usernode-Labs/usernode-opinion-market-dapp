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
    86400000, // 1 day — the daily-BTC question cadence
    2 * 86400000, 3 * 86400000, 4 * 86400000, 5 * 86400000, 6 * 86400000, 7 * 86400000,
    14 * 86400000, 30 * 86400000, 90 * 86400000,
  ]);
  var ALLOWED_REVEAL_INTERVALS = new Set([86400000, 172800000, 259200000, 604800000]);

  /* ── Proposals (community question creation) ──────────────────────── */

  // Sliding window used to size the promotion electorate. A proposal goes
  // live once its upvoter set reaches at least half of the users active in
  // the trailing 72h (measured at the triggering tx's timestamp).
  var PROPOSAL_ACTIVE_WINDOW_MS = 72 * 60 * 60 * 1000;
  // An un-promoted proposal expires after this long from its proposedAtMs.
  var PROPOSAL_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
  // Per-user cap on simultaneously-open (non-promoted, non-expired) proposals.
  var MAX_OPEN_PROPOSALS_PER_USER = 3;
  // Memo types that count a sender as "active" for the 72h electorate. Read
  // from the plaintext tx envelope only — no vote decryption needed (a
  // vote's `type` is plaintext even though its choice is encrypted).
  // Excludes cosmetic set_username and server-authored key txs.
  var ACTIVITY_TYPES = new Set([
    "join", "create_survey", "add_option", "vote", "place_bet",
    "sell_shares", "propose_question", "upvote_proposal",
  ]);

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
    // Daily-BTC marker fields. These ride inside the survey definition so a
    // server-authored `create_daily_btc` memo can carry the strike and the
    // pricing timestamp through replay untouched. Plain surveys leave `kind`
    // null and the numeric fields null.
    var kind = typeof rawSurvey.kind === "string" && rawSurvey.kind ? rawSurvey.kind : null;
    var strikeUsd = pickNumber(rawSurvey.strike_usd, rawSurvey.strikeUsd);
    var pricedAt = pickNumber(rawSurvey.priced_at, rawSurvey.pricedAt);
    return {
      id: idBase, title: title, question: question, activeDurationMs: activeDurationMs,
      options: options, revealIntervalMs: revealIntervalMs, allowCustomOptions: allowCustomOptions,
      kind: kind, strikeUsd: strikeUsd, pricedAt: pricedAt,
    };
  }

  function pickNumber(a, b) {
    if (typeof a === "number" && Number.isFinite(a)) return a;
    if (typeof b === "number" && Number.isFinite(b)) return b;
    return null;
  }

  /**
   * Normalize a `create_wc26_match` memo's `match` payload into a survey
   * definition (same shape `normalizeSurveyDefinition` returns) carrying a
   * `wc26` sub-object. Unlike standard surveys, WC26 matches have a VARIABLE
   * `activeDurationMs` (kickoffMs - createdAtMs + 8h) that is NOT in
   * `ALLOWED_SURVEY_DURATION_MS`, so this bypasses `normalizeSurveyDurationMs`
   * and trusts the server-baked value verbatim (the server is the sole author
   * of these memos — see world-cup-2026.js). Returns null if invalid.
   */
  function normalizeWc26Definition(rawMatch) {
    if (!rawMatch || typeof rawMatch !== "object") return null;
    var id = String(rawMatch.id || rawMatch.matchId || "").trim();
    if (!id) return null;
    var title = String(rawMatch.title || "").trim() || id;
    var question = String(rawMatch.question || "").trim() || title;
    var optionsRaw = Array.isArray(rawMatch.options) ? rawMatch.options : [];
    var options = [];
    for (var i = 0; i < optionsRaw.length; i++) {
      var o = optionsRaw[i];
      if (!o || typeof o !== "object") continue;
      var key = String(o.key || "").trim();
      if (!key) continue;
      var label = String(o.label || "").trim() || key;
      options.push({ key: key, label: label });
    }
    if (options.length < 2) return null;
    var activeDurationMs = pickNumber(rawMatch.active_duration_ms, rawMatch.activeDurationMs);
    if (!Number.isFinite(activeDurationMs) || activeDurationMs <= 0) {
      activeDurationMs = DEFAULT_SURVEY_DURATION_MS;
    }
    var kickoffMs = pickNumber(rawMatch.kickoff_ms, rawMatch.kickoffMs);
    return {
      id: id, title: title, question: question,
      activeDurationMs: activeDurationMs, options: options,
      revealIntervalMs: null, allowCustomOptions: false,
      kind: "wc26_match", strikeUsd: null, pricedAt: null,
      wc26: {
        matchId: id,
        stage: rawMatch.stage ? String(rawMatch.stage) : "group",
        group: rawMatch.group != null && rawMatch.group !== "" ? String(rawMatch.group) : null,
        homeTeam: String(rawMatch.home_team || rawMatch.homeTeam || ""),
        awayTeam: String(rawMatch.away_team || rawMatch.awayTeam || ""),
        homeTeamName: String(rawMatch.home_team_name || rawMatch.homeTeamName || rawMatch.home_team || rawMatch.homeTeam || ""),
        awayTeamName: String(rawMatch.away_team_name || rawMatch.awayTeamName || rawMatch.away_team || rawMatch.awayTeam || ""),
        kickoffMs: Number.isFinite(kickoffMs) ? kickoffMs : null,
        venue: rawMatch.venue ? String(rawMatch.venue) : "",
      },
    };
  }

  function normalizeProposalDefinition(rawProposal, fromAddr) {
    if (!rawProposal || typeof rawProposal !== "object") return null;
    var title = String(rawProposal.title || "").trim();
    var question = String(rawProposal.question || "").trim();
    if (!title || !question) return null;
    var optionsRaw = Array.isArray(rawProposal.options) ? rawProposal.options : [];
    var options = [];
    for (var i = 0; i < optionsRaw.length; i++) {
      var o = optionsRaw[i];
      if (!o || typeof o !== "object") continue;
      var label = String(o.label || "").trim();
      if (!label) continue;
      options.push({ key: String(o.key || slugify(label) || "opt_" + (i + 1)), label: label });
    }
    // Deterministic, cross-proposer-unique id: slug of the title suffixed
    // with the proposer's address tail. Two proposers proposing the same
    // title get distinct proposals; the same proposer re-proposing the same
    // title updates the existing one (latest definition wins).
    var slug = slugify(title);
    var id = (slug || "q") + "_" + last6(fromAddr);
    var allowCustomOptions = rawProposal.allow_custom_options !== false;
    return { id: id, title: title, question: question, options: options, allowCustomOptions: allowCustomOptions };
  }

  /**
   * Distinct senders whose ACTIVITY_TYPES tx falls in
   * (refMs - PROPOSAL_ACTIVE_WINDOW_MS, refMs]. Pure; takes the already-
   * parsed/sorted tx list ([{ tx, memo }]) so callers reuse one parse.
   */
  function activeUsersInWindow(parsedTxs, refMs) {
    var set = new Set();
    var lo = refMs - PROPOSAL_ACTIVE_WINDOW_MS;
    for (var i = 0; i < parsedTxs.length; i++) {
      var P = parsedTxs[i];
      if (!P || !P.tx || !P.memo || !P.tx.from) continue;
      if (!ACTIVITY_TYPES.has(P.memo.type)) continue;
      if (P.tx.ts > lo && P.tx.ts <= refMs) set.add(P.tx.from);
    }
    return set;
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
   *     earningsMap          — Map<pubkey, { totalEarnings, marketsBetOn, marketsVotedOn, marketsWon }>
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

    /* --- Phase 3a: Proposals & Promotion ---
     *
     * Community question creation. Anyone (subject to genesis gating) can
     * `propose_question`; anyone can `upvote_proposal`. A proposal goes live
     * the moment its upvoter set reaches at least half of the users active
     * in the trailing 72h. This bypasses Phase 3's admin/cooldown gate on
     * purpose — promoted proposals are a separate, community-authorized
     * survey source.
     *
     * Determinism: we walk propose/upvote events in chronological order and
     * anchor the active-user denominator to each triggering tx's ts (never
     * `now`). Once promoted, a proposal latches (later upvotes ignored).
     * Expiry and the per-user open cap are pure functions of timestamps, so
     * client and server replay always agree. */
    var PROPOSALS = new Map();

    function evaluateProposalPromotion(pr, ts) {
      if (pr.promoted) return;
      var activeCount = activeUsersInWindow(parsed, ts).size;
      if (activeCount < 1) return; // no electorate → never promote
      var threshold = Math.ceil(activeCount / 2); // "at least half", rounded up
      if (pr.upvoters.size >= threshold) { pr.promoted = true; pr.promotedAtMs = ts; }
    }

    for (var ixp = 0; ixp < parsed.length; ixp++) {
      var Pp = parsed[ixp];
      if (Pp.memo.type === "propose_question") {
        if (!isGenesisAccount(Pp.tx.from)) continue;
        var pdef = normalizeProposalDefinition(Pp.memo.proposal, Pp.tx.from);
        if (!pdef) continue;
        var existingPr = PROPOSALS.get(pdef.id);
        if (existingPr) {
          // Same proposer re-proposing the same title: latest definition
          // wins and the expiry clock resets. Keep the accrued upvoters.
          if (Pp.tx.ts >= existingPr.proposedAtMs) {
            existingPr.def = pdef;
            existingPr.proposedAtMs = Pp.tx.ts;
          }
          existingPr.upvoters.add(Pp.tx.from);
          evaluateProposalPromotion(existingPr, Pp.tx.ts);
          continue;
        }
        // Per-user open-proposal cap: count this proposer's still-open
        // (non-promoted, non-expired-as-of-now) proposals at this instant.
        var openCount = 0;
        PROPOSALS.forEach(function (pr) {
          if (pr.proposedBy !== Pp.tx.from) return;
          if (pr.promoted) return;
          if (pr.proposedAtMs + PROPOSAL_EXPIRY_MS <= Pp.tx.ts) return;
          openCount++;
        });
        if (openCount >= MAX_OPEN_PROPOSALS_PER_USER) continue; // over cap → drop
        var newPr = {
          id: pdef.id, def: pdef, proposedBy: Pp.tx.from, proposedAtMs: Pp.tx.ts,
          upvoters: new Set([Pp.tx.from]), promoted: false, promotedAtMs: null,
        };
        PROPOSALS.set(pdef.id, newPr);
        // Proposer auto-upvotes their own proposal; evaluate immediately so
        // a brand-new proposal in a tiny active population can go live at
        // once (see "zero active users" edge case in the spec).
        evaluateProposalPromotion(newPr, Pp.tx.ts);
      } else if (Pp.memo.type === "upvote_proposal") {
        if (!isGenesisAccount(Pp.tx.from)) continue;
        var pid = Pp.memo.proposal == null ? null : String(Pp.memo.proposal);
        if (!pid) continue;
        var pr2 = PROPOSALS.get(pid);
        if (!pr2 || pr2.promoted) continue; // missing or latched → no-op
        if (pr2.proposedAtMs + PROPOSAL_EXPIRY_MS <= Pp.tx.ts) continue; // expired
        pr2.upvoters.add(Pp.tx.from); // Set → double-upvote deduped
        evaluateProposalPromotion(pr2, Pp.tx.ts);
      }
    }

    // Synthetic survey-creation records for promoted proposals, shaped like
    // Phase 3's allCreations entries so they merge into latestCreated below.
    var PROMOTED_SURVEYS = [];
    PROPOSALS.forEach(function (pr) {
      if (!pr.promoted) return;
      var sv = normalizeSurveyDefinition({
        id: pr.def.id, title: pr.def.title, question: pr.def.question,
        options: pr.def.options, allow_custom_options: pr.def.allowCustomOptions,
        active_duration_ms: DEFAULT_SURVEY_DURATION_MS, reveal_interval_ms: null,
      });
      if (sv) PROMOTED_SURVEYS.push({ survey: sv, ts: pr.promotedAtMs, from: pr.proposedBy });
    });

    /* --- Phase 3b: Daily BTC questions + oracle resolutions ---
     *
     * `create_daily_btc` and `resolve_btc` are server-authored memos. They
     * bypass the admin gate entirely (like promoted proposals) — the server's
     * sender pubkey is not the admin. Determinism across restarts and the
     * parallel-deploy topology (two servers sharing APP_PUBKEY may each post a
     * memo with a marginally different CoinGecko reading) is guaranteed by
     * deterministic per-day ids plus an EARLIEST-memo-wins tie-break (tx ts,
     * then tx id). Replay never calls CoinGecko — every price is read off-chain. */
    var BTC_CREATIONS = new Map();   // surveyId -> { survey, ts, from, txId }
    var BTC_RESOLUTIONS = new Map(); // surveyId -> { winner, strikeUsd, resolvedPriceUsd, resolvedAt, ts, txId }
    function earlierWins(prev, ts, txId) {
      if (!prev) return true;
      if (ts !== prev.ts) return ts < prev.ts;
      return String(txId) < String(prev.txId);
    }
    for (var ixb = 0; ixb < parsed.length; ixb++) {
      var Pb = parsed[ixb];
      if (Pb.memo.type === "create_daily_btc") {
        var svb = normalizeSurveyDefinition(Pb.memo.survey);
        if (!svb || svb.kind !== "btc_daily") continue;
        var prevB = BTC_CREATIONS.get(svb.id);
        if (earlierWins(prevB, Pb.tx.ts, Pb.tx.id)) {
          BTC_CREATIONS.set(svb.id, { survey: svb, ts: Pb.tx.ts, from: Pb.tx.from, txId: Pb.tx.id });
        }
      } else if (Pb.memo.type === "resolve_btc" && Pb.memo.survey != null) {
        var rid = String(Pb.memo.survey);
        var rWinner = Pb.memo.winner == null ? null : String(Pb.memo.winner);
        if (rWinner !== "higher" && rWinner !== "lower") rWinner = null; // null = push/tie
        var prevR = BTC_RESOLUTIONS.get(rid);
        if (earlierWins(prevR, Pb.tx.ts, Pb.tx.id)) {
          BTC_RESOLUTIONS.set(rid, {
            winner: rWinner,
            strikeUsd: pickNumber(Pb.memo.strike_usd, Pb.memo.strikeUsd),
            resolvedPriceUsd: pickNumber(Pb.memo.resolved_price_usd, Pb.memo.resolvedPriceUsd),
            resolvedAt: pickNumber(Pb.memo.resolved_at, Pb.memo.resolvedAt) || Pb.tx.ts,
            ts: Pb.tx.ts, txId: Pb.tx.id,
          });
        }
      }
    }

    /* --- Phase 3c: World Cup 2026 match markets + oracle resolutions ---
     *
     * `create_wc26_match` and `resolve_wc26_match` are server-authored memos
     * (see world-cup-2026.js). Like daily-BTC they bypass the admin gate (the
     * server's sender is not the admin) and resolve via an on-chain oracle
     * memo, NEVER by vote majority. Determinism across restarts and parallel
     * deploys is guaranteed by the matchId (= survey id) plus the same
     * EARLIEST-memo-wins tie-break used by Phase 3b. Replay never calls the
     * football API — the winner is read straight off `resolve_wc26_match`. */
    var WC26_CREATIONS = new Map();   // matchId -> { survey, ts, from, txId }
    var WC26_RESOLUTIONS = new Map(); // matchId -> { winnerKey, resolvedAt, ts, txId }
    for (var ixw = 0; ixw < parsed.length; ixw++) {
      var Pw = parsed[ixw];
      if (Pw.memo.type === "create_wc26_match") {
        var svw = normalizeWc26Definition(Pw.memo.match || Pw.memo.survey);
        if (!svw) continue;
        var prevW = WC26_CREATIONS.get(svw.id);
        if (earlierWins(prevW, Pw.tx.ts, Pw.tx.id)) {
          WC26_CREATIONS.set(svw.id, { survey: svw, ts: Pw.tx.ts, from: Pw.tx.from, txId: Pw.tx.id });
        }
      } else if (Pw.memo.type === "resolve_wc26_match") {
        var wid = Pw.memo.matchId != null ? String(Pw.memo.matchId)
          : (Pw.memo.match && Pw.memo.match.id != null) ? String(Pw.memo.match.id)
          : (Pw.memo.survey != null ? String(Pw.memo.survey) : null);
        if (!wid) continue;
        var wWinner = Pw.memo.winnerKey != null ? String(Pw.memo.winnerKey)
          : (Pw.memo.winner != null ? String(Pw.memo.winner) : null);
        var prevWR = WC26_RESOLUTIONS.get(wid);
        if (earlierWins(prevWR, Pw.tx.ts, Pw.tx.id)) {
          WC26_RESOLUTIONS.set(wid, {
            winnerKey: wWinner,
            resolvedAt: pickNumber(Pw.memo.resolved_at, Pw.memo.resolvedAt) || Pw.tx.ts,
            ts: Pw.tx.ts, txId: Pw.tx.id,
          });
        }
      }
    }

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
    // Merge promoted proposals as surveys, NOT subject to the admin filter
    // or per-sender cooldown above. On id collision with an existing
    // create_survey survey, suffix so we never clobber an admin survey.
    for (var pmi = 0; pmi < PROMOTED_SURVEYS.length; pmi++) {
      var pmEntry = PROMOTED_SURVEYS[pmi];
      var sid = pmEntry.survey.id;
      if (latestCreated.has(sid)) sid = sid + "_" + last6(pmEntry.from);
      if (latestCreated.has(sid)) sid = sid + "_" + String(pmEntry.ts).slice(-4);
      latestCreated.set(sid, {
        survey: Object.assign({}, pmEntry.survey, { id: sid }),
        ts: pmEntry.ts,
        from: pmEntry.from,
      });
    }
    // Merge daily-BTC questions, also bypassing the admin gate / cooldown.
    // `from` is forced to null so Phase 5b skips creator-ante seeding (no
    // joined creator) and Phase 6 seeds the market lazily from platform
    // liquidity on the first bet — no ante charged, no creator reward leaked.
    BTC_CREATIONS.forEach(function (b) {
      latestCreated.set(b.survey.id, { survey: b.survey, ts: b.ts, from: null });
    });
    // Merge World Cup 2026 match markets, same bypass as daily-BTC: `from` is
    // null so Phase 5b skips creator-ante seeding and Phase 6 seeds the market
    // lazily from platform liquidity on the first bet.
    WC26_CREATIONS.forEach(function (w) {
      latestCreated.set(w.survey.id, { survey: w.survey, ts: w.ts, from: null });
    });
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

    /* Settlement logic, extracted so it can fire inline at expiresAtMs.
     * Computes the settlement for one survey based on the current MARKETS
     * state for it and the (already-finalized) voteMap. Mutates
     * CREDIT_FLOWS to credit payouts/dividends to affected users. Idempotent
     * to call once per survey (and that's all we do — one settlement event
     * per archived survey). */
    function settleSurvey(survey) {
      var mkt = MARKETS.get(survey.id);

      var voteCounts = {};
      for (var vo = 0; vo < survey.options.length; vo++) voteCounts[survey.options[vo].key] = 0;
      var voterSet = new Set();
      var vmEntries = Array.from(voteMap.entries());
      for (var ve = 0; ve < vmEntries.length; ve++) {
        var v = vmEntries[ve][1];
        if (v.survey !== survey.id) continue;
        voteCounts[v.choice] = (voteCounts[v.choice] || 0) + 1;
        voterSet.add(v.from);
      }

      var totalPool = mkt ? cpmmTotalLiquidity(mkt) : 0;
      var settlement = {
        winner: null, payouts: {}, voterDividendPer: 0, surprise: {},
        totalPool: totalPool, feePool: mkt ? mkt.feePool : 0,
        voteCounts: voteCounts, voterCount: voterSet.size, voters: voterSet,
      };

      /* Daily-BTC oracle settlement. These markets resolve against the real
       * next-day price posted on-chain by the server, NEVER by vote majority.
       * If the resolution memo hasn't landed yet (expired-but-unresolved), the
       * survey is left `pending` and pays no one — a later resolve_btc tx
       * settles it on the next rebuild. */
      if (survey.kind === "btc_daily") {
        var btcRes = BTC_RESOLUTIONS.get(survey.id);
        settlement.kind = "btc_daily";
        settlement.strikeUsd = (typeof survey.strikeUsd === "number") ? survey.strikeUsd : null;
        if (!btcRes) {
          settlement.pending = true;
          settlement.resolvedPriceUsd = null;
          settlement.btcWinner = null;
          SETTLEMENTS.set(survey.id, settlement);
          return;
        }
        settlement.resolvedPriceUsd = btcRes.resolvedPriceUsd;
        settlement.btcWinner = btcRes.winner;
        settlement.resolvedAt = btcRes.resolvedAt;
        // Record the resolved winner regardless of whether a market/trades
        // exist. BTC markets are not tradeable, so they have no seeded
        // market or share holders — but a resolved BTC question must still
        // display its winner.
        if (btcRes.winner !== null) {
          settlement.winner = btcRes.winner;
          settlement.winners = [btcRes.winner];
        }
        if (mkt && totalPool > 0) {
          settlement.feePool = mkt.feePool;
          if (btcRes.winner === null) {
            // Push / tie — refund all share holders proportionally.
            distributeRefund(mkt, settlement);
          } else {
            var bweights = {};
            for (var bwi = 0; bwi < survey.options.length; bwi++) bweights[survey.options[bwi].key] = 0;
            bweights[btcRes.winner] = 1;
            settlement.winner = btcRes.winner;
            settlement.winners = [btcRes.winner];
            settlement.resolutionWeights = bweights;
            // YES holders of the winning option get 1x per share; others 0.
            var byEntries = Object.entries(mkt.userShares);
            for (var byi = 0; byi < byEntries.length; byi++) {
              var bpkY = byEntries[byi][0];
              var bShares = Object.entries(byEntries[byi][1]);
              for (var bsi = 0; bsi < bShares.length; bsi++) {
                var bw = bweights[bShares[bsi][0]] || 0;
                if (bw > 0 && bShares[bsi][1] > 0) {
                  settlement.payouts[bpkY] = (settlement.payouts[bpkY] || 0) + bShares[bsi][1] * bw;
                }
              }
            }
            // NO holders pay out (1 - weight) per share.
            var bnEntries = Object.entries(mkt.userNoShares || {});
            for (var bni = 0; bni < bnEntries.length; bni++) {
              var bpkN = bnEntries[bni][0];
              var bNo = Object.entries(bnEntries[bni][1]);
              for (var bnoi = 0; bnoi < bNo.length; bnoi++) {
                if (bNo[bnoi][1] <= 0) continue;
                var bnoPayout = (1 - (bweights[bNo[bnoi][0]] || 0)) * bNo[bnoi][1];
                if (bnoPayout > 0) settlement.payouts[bpkN] = (settlement.payouts[bpkN] || 0) + bnoPayout;
              }
            }
          }
          if (voterSet.size > 0 && mkt.feePool > 0) {
            settlement.voterDividendPer = mkt.feePool / voterSet.size;
          }
          var bpo = Object.entries(settlement.payouts);
          for (var bpoi = 0; bpoi < bpo.length; bpoi++) getCreditFlow(bpo[bpoi][0]).payouts += bpo[bpoi][1];
          if (settlement.voterDividendPer > 0) {
            var bvs = Array.from(voterSet);
            for (var bvsi = 0; bvsi < bvs.length; bvsi++) getCreditFlow(bvs[bvsi]).dividends += settlement.voterDividendPer;
          }
        }
        SETTLEMENTS.set(survey.id, settlement);
        return;
      }

      /* World Cup 2026 oracle settlement. Resolves against the on-chain
       * `resolve_wc26_match` winner key, NEVER by vote majority. A missing
       * resolution leaves the survey `pending` (a later resolve memo settles
       * it next rebuild). A "void" / null / unknown winner (postponed or
       * cancelled match, or API outage past expiry) refunds all share
       * holders proportionally. */
      if (survey.kind === "wc26_match") {
        var wcRes = WC26_RESOLUTIONS.get(survey.id);
        settlement.kind = "wc26_match";
        if (!wcRes) {
          settlement.pending = true;
          settlement.wcWinner = null;
          SETTLEMENTS.set(survey.id, settlement);
          return;
        }
        settlement.wcWinner = wcRes.winnerKey;
        settlement.resolvedAt = wcRes.resolvedAt;
        var wcValidWinner = wcRes.winnerKey != null && wcRes.winnerKey !== "void" &&
          survey.options.some(function (o) { return o.key === wcRes.winnerKey; });
        if (mkt && totalPool > 0) {
          settlement.feePool = mkt.feePool;
          if (!wcValidWinner) {
            // void / unknown → refund all holders proportionally.
            distributeRefund(mkt, settlement);
          } else {
            var wcWeights = {};
            for (var wcwi = 0; wcwi < survey.options.length; wcwi++) wcWeights[survey.options[wcwi].key] = 0;
            wcWeights[wcRes.winnerKey] = 1;
            settlement.winner = wcRes.winnerKey;
            settlement.winners = [wcRes.winnerKey];
            settlement.resolutionWeights = wcWeights;
            // YES holders of the winning option get 1x per share; others 0.
            var wcYes = Object.entries(mkt.userShares);
            for (var wcyi = 0; wcyi < wcYes.length; wcyi++) {
              var wcPkY = wcYes[wcyi][0];
              var wcShares = Object.entries(wcYes[wcyi][1]);
              for (var wcsi = 0; wcsi < wcShares.length; wcsi++) {
                var wcw = wcWeights[wcShares[wcsi][0]] || 0;
                if (wcw > 0 && wcShares[wcsi][1] > 0) {
                  settlement.payouts[wcPkY] = (settlement.payouts[wcPkY] || 0) + wcShares[wcsi][1] * wcw;
                }
              }
            }
            // NO holders pay out (1 - weight) per share.
            var wcNo = Object.entries(mkt.userNoShares || {});
            for (var wcni = 0; wcni < wcNo.length; wcni++) {
              var wcPkN = wcNo[wcni][0];
              var wcNoSh = Object.entries(wcNo[wcni][1]);
              for (var wcnoi = 0; wcnoi < wcNoSh.length; wcnoi++) {
                if (wcNoSh[wcnoi][1] <= 0) continue;
                var wcNoPayout = (1 - (wcWeights[wcNoSh[wcnoi][0]] || 0)) * wcNoSh[wcnoi][1];
                if (wcNoPayout > 0) settlement.payouts[wcPkN] = (settlement.payouts[wcPkN] || 0) + wcNoPayout;
              }
            }
          }
          if (voterSet.size > 0 && mkt.feePool > 0) {
            settlement.voterDividendPer = mkt.feePool / voterSet.size;
          }
          var wcPo = Object.entries(settlement.payouts);
          for (var wcpoi = 0; wcpoi < wcPo.length; wcpoi++) getCreditFlow(wcPo[wcpoi][0]).payouts += wcPo[wcpoi][1];
          if (settlement.voterDividendPer > 0) {
            var wcVs = Array.from(voterSet);
            for (var wcvsi = 0; wcvsi < wcVs.length; wcvsi++) getCreditFlow(wcVs[wcvsi]).dividends += settlement.voterDividendPer;
          }
        }
        SETTLEMENTS.set(survey.id, settlement);
        return;
      }

      if (mkt && totalPool > 0) {
        settlement.feePool = mkt.feePool;
        var totalVotes = Object.values(voteCounts).reduce(function (a, b) { return a + b; }, 0);

        for (var soi = 0; soi < survey.options.length; soi++) {
          var vs = totalVotes > 0 ? (voteCounts[survey.options[soi].key] || 0) / totalVotes : 0;
          var pool8 = mkt.pools[survey.options[soi].key];
          var mp = pool8 && CPMM.cpmmProb ? CPMM.cpmmProb(pool8) : 0;
          settlement.surprise[survey.options[soi].key] = vs - mp;
        }

        if (totalVotes === 0) {
          distributeRefund(mkt, settlement);
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
          for (var owi = 0; owi < survey.options.length; owi++) weights[survey.options[owi].key] = 0;
          for (var wi = 0; wi < winners.length; wi++) weights[winners[wi]] = 1 / K;
          settlement.resolutionWeights = weights;

          var ysEntries = Object.entries(mkt.userShares);
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
          var nsEntries = Object.entries(mkt.userNoShares || {});
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

        if (voterSet.size > 0 && mkt.feePool > 0) {
          settlement.voterDividendPer = mkt.feePool / voterSet.size;
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

      SETTLEMENTS.set(survey.id, settlement);
    }

    /* --- Phase 6/7 (interleaved): Trades + settlements in chronological order ---
     *
     * The bug this interleaving fixes: previously Phase 6 walked every
     * place_bet/sell_shares first, then Phase 7 ran settlements at the
     * end. That meant during the Phase 6 walk, payouts from already-
     * expired surveys were not yet credited to CREDIT_FLOWS, so a bet
     * placed days AFTER a previous survey settled would fail the
     * `bal < credits` check using a pre-settlement balance. The header
     * (which reads the post-rebuild state) reported the correct,
     * post-settlement balance — so users saw e.g. 822 credits, tried to
     * bet 320, the bet passed the client preflight, hit the chain, and
     * was then silently dropped by the next rebuild. This is what
     * burned scraido and maragung's tx fees in May 2026.
     *
     * Fix: merge trades and "survey expired" events into a single
     * chronologically-sorted stream. When a settlement fires inline at
     * `expiresAtMs`, its payouts/dividends land in CREDIT_FLOWS BEFORE
     * subsequent trades evaluate their balance. Every silent rejection
     * also gets logged to REJECTED_SENDS so the UI can surface "your
     * bet was dropped because X" feedback. */
    var tradeEvents = [];
    for (var ix7 = 0; ix7 < parsed.length; ix7++) {
      var pt = parsed[ix7];
      if (pt.memo.type === "place_bet" || pt.memo.type === "sell_shares") {
        // Trading is disabled for the daily-BTC oracle market. Skip its
        // trades at collection time so they never reach the processing
        // loop, never seed a BTC market, and are ignored SILENTLY (no
        // recordReject) — the UI never offers BTC betting, so any BTC
        // trade memo is hand-crafted and shouldn't surface in the
        // "your bet was dropped" banner.
        var tradeSurvey = pt.memo.survey == null ? null : SURVEYS_BY_ID.get(String(pt.memo.survey));
        if (tradeSurvey && tradeSurvey.kind === "btc_daily") continue;
        tradeEvents.push({ kind: "trade", ts: pt.tx.ts, p: pt });
      }
    }
    var settlementEvents = [];
    for (var ssx = 0; ssx < SURVEYS.length; ssx++) {
      if (SURVEYS[ssx].archived) {
        settlementEvents.push({ kind: "settle", ts: SURVEYS[ssx].expiresAtMs, survey: SURVEYS[ssx] });
      }
    }
    var events = tradeEvents.concat(settlementEvents);
    events.sort(function (a, b) {
      if (a.ts !== b.ts) return a.ts - b.ts;
      // At a tie: settlements BEFORE trades at the same instant, so a
      // trade at exactly `expiresAtMs` (itself rejected as EXPIRED on
      // that survey) can't beat a co-located settlement that should
      // have already credited some OTHER user's payouts.
      if (a.kind === "settle" && b.kind === "trade") return -1;
      if (a.kind === "trade" && b.kind === "settle") return 1;
      return 0;
    });

    for (var iev = 0; iev < events.length; iev++) {
      var ev = events[iev];
      if (ev.kind === "settle") { settleSurvey(ev.survey); continue; }
      var Pm = ev.p;
      var svM = Pm.memo.survey == null ? null : String(Pm.memo.survey);
      var surveyM = SURVEYS_BY_ID.get(svM);
      if (!surveyM) { recordReject(Pm, "NO_SURVEY"); continue; }
      // Belt-and-suspenders: BTC-market trades are filtered out above, but
      // never process one here even if a future refactor lets it through.
      // Ignore silently (no recordReject) and never seed a BTC market.
      if (surveyM.kind === "btc_daily") continue;
      // World Cup matches lock at kickoff (well before the kickoff+8h expiry),
      // so a bet/sell whose chain ts lands at/after kickoff is dropped with a
      // distinct reason — no betting on a result that may already be known.
      if (surveyM.kind === "wc26_match" && surveyM.wc26 &&
          typeof surveyM.wc26.kickoffMs === "number" && Pm.tx.ts >= surveyM.wc26.kickoffMs) {
        recordReject(Pm, "MATCH_LOCKED", { kickoffMs: surveyM.wc26.kickoffMs });
        continue;
      }
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
        if (!ent) { ent = { totalEarnings: 0, marketsBetOn: 0, marketsVotedOn: 0, marketsWon: 0 }; earningsMap.set(pubkey, ent); }
        ent.marketsBetOn++;
        ent.totalEarnings += profit;
        if (hadWinningShares && payout > 0) ent.marketsWon++;
      }
    }

    /* --- Phase 8b: marketsVotedOn (from voteMap, all surveys) --- */
    var vmIter = voteMap.entries();
    var vmNext = vmIter.next();
    while (!vmNext.done) {
      var vEntry = vmNext.value[1];
      var ent2 = earningsMap.get(vEntry.from);
      if (!ent2) { ent2 = { totalEarnings: 0, marketsBetOn: 0, marketsVotedOn: 0, marketsWon: 0 }; earningsMap.set(vEntry.from, ent2); }
      ent2.marketsVotedOn++;
      vmNext = vmIter.next();
    }

    // Open proposals = not promoted and not expired as of `now`, newest-first.
    var openProposals = [];
    PROPOSALS.forEach(function (pr) {
      if (pr.promoted) return;
      if (pr.proposedAtMs + PROPOSAL_EXPIRY_MS <= now) return;
      openProposals.push(pr);
    });
    openProposals.sort(function (a, b) { return b.proposedAtMs - a.proposedAtMs; });

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
      PROPOSALS: PROPOSALS,
      openProposals: openProposals,
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
    // Trading is disabled for the daily-BTC oracle market — Phase 6 ignores
    // its trade memos entirely, so reject the preflight up front.
    if (survey.kind === "btc_daily") return { ok: false, reason: "BTC_NO_TRADING" };
    if (survey.archived) return { ok: false, reason: "ARCHIVED" };
    if (survey.kind === "wc26_match" && survey.wc26 && typeof survey.wc26.kickoffMs === "number") {
      var nowMs = typeof params.now === "number" ? params.now : Date.now();
      if (nowMs >= survey.wc26.kickoffMs) return { ok: false, reason: "MATCH_LOCKED" };
    }
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
    PROPOSAL_ACTIVE_WINDOW_MS: PROPOSAL_ACTIVE_WINDOW_MS,
    PROPOSAL_EXPIRY_MS: PROPOSAL_EXPIRY_MS,
    MAX_OPEN_PROPOSALS_PER_USER: MAX_OPEN_PROPOSALS_PER_USER,
    ACTIVITY_TYPES: ACTIVITY_TYPES,

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
    normalizeWc26Definition: normalizeWc26Definition,
    normalizeProposalDefinition: normalizeProposalDefinition,
    activeUsersInWindow: activeUsersInWindow,
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
