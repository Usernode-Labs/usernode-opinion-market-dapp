/**
 * Leaderboard — server-side port of the client's full state-rebuild pipeline
 * from public/index.html (computeResults / rebuildState).
 *
 * Given the same raw OM transactions the client receives, this module
 * produces the same per-user statistics: current credit balance, total
 * earnings (Bet P&L), markets participated, markets won, and win rate.
 *
 * Source of truth is still the client. This module exists so that the
 * GET /leaderboard JSON API can answer without round-tripping through a
 * browser. If client logic changes meaningfully, mirror the change here.
 *
 * Vote decryption uses Node's WebCrypto (globalThis.crypto.subtle, available
 * in Node 16+) so the ECDH P-256 + AES-GCM scheme matches the browser
 * exactly.
 */

const CPMM = require("../public/opinion-market-core.js");

// Constants — must stay in lockstep with public/index.html
const INITIAL_CREDITS = 1000;
const FEE_RATE = 0.05;
const LIQUIDITY_FEE_RATE = 0.02;
const MARKET_ANTE = 50;
const PLATFORM_LIQUIDITY = 450;
const CREATOR_REWARD_RATE = 0.005;
const CREATOR_REWARD_CAP = 100;
const MAX_BET_POOL_RATIO = 0.30;
const SURVEY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_SURVEYS_PER_WINDOW = 999;
const ALLOWED_SURVEY_DURATION_MS = new Set([
  60_000, 180_000, 600_000,
  2 * 86400000, 3 * 86400000, 4 * 86400000, 5 * 86400000, 6 * 86400000, 7 * 86400000,
  14 * 86400000, 30 * 86400000, 90 * 86400000,
]);
const DEFAULT_SURVEY_DURATION_MS = 7 * 86400000;
const ALLOWED_REVEAL_INTERVALS = new Set([86400000, 172800000, 259200000, 604800000]);

// ── Generic helpers ─────────────────────────────────────────────────────────
function pick(obj, keys) { for (const k of keys) { if (obj && obj[k] != null) return obj[k]; } return null; }

function extractTxTimestampMs(tx) {
  if (!tx || typeof tx !== "object") return null;
  const candidates = [tx.created_at, tx.createdAt, tx.timestamp_ms, tx.timestampMs, tx.timestamp, tx.time];
  for (const v of candidates) {
    if (typeof v === "number" && Number.isFinite(v)) return v < 10_000_000_000 ? v * 1000 : v;
    if (typeof v === "string" && v.trim()) { const t = Date.parse(v); if (!Number.isNaN(t)) return t; }
  }
  return null;
}

function normalizeTx(tx) {
  if (!tx || typeof tx !== "object") return null;
  return {
    id: (() => { const v = pick(tx, ["id", "txid", "tx_id", "hash"]); return v == null ? null : String(v); })(),
    from: (() => { const v = pick(tx, ["from_pubkey", "from", "source", "fromAddress", "from_address"]); return v == null ? null : String(v); })(),
    to: (() => { const v = pick(tx, ["destination_pubkey", "to", "destination", "toAddress", "to_address"]); return v == null ? null : String(v); })(),
    amount: pick(tx, ["amount"]),
    memo: (() => { const v = pick(tx, ["memo"]); return v == null ? null : String(v); })(),
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
    const tx = normalizeTx(rawTx);
    if (!tx || !tx.from || !tx.to || tx.to !== appPubkey) return null;
    const memoObj = parseMemo(tx.memo);
    if (!memoObj) return null;
    if (String(memoObj.app || "") !== "opinion-market") return null;
    return { tx, memo: memoObj };
  };
}

function slugify(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

function last6(s) { const v = String(s || ""); return v.length >= 6 ? v.slice(-6) : v; }

function usernameSuffix(address) { const c = last6(address); return c ? `_${c}` : "_unknown"; }

function deriveDefaultUsername(address) { return `user${usernameSuffix(address)}`; }

function normalizeUsername(raw, fallback, addressForSuffix) {
  const suffix = usernameSuffix(addressForSuffix);
  const maxBaseLen = Math.max(1, 24 - suffix.length);
  const fallbackValue = (() => {
    const f = String(fallback || "").trim();
    if (!f) return `user${suffix}`;
    if (f.endsWith(suffix)) return f.slice(0, maxBaseLen) + suffix;
    const stripped = f.replace(/_[A-Za-z0-9]{6}$/, "").slice(0, maxBaseLen);
    return (stripped || "user") + suffix;
  })();
  let v = String(raw || "").trim();
  if (!v) return fallbackValue;
  v = v.replace(/[^\w-]/g, "");
  if (!v) return fallbackValue;
  if (v.endsWith(suffix)) return v.slice(0, maxBaseLen) + suffix;
  const stripped = v.replace(/_[A-Za-z0-9]{6}$/, "").slice(0, maxBaseLen);
  return (stripped || "user") + suffix;
}

function normalizeSurveyDurationMs(v) {
  const n = typeof v === "number" ? Math.round(v) : Number(v);
  if (!Number.isFinite(n)) return DEFAULT_SURVEY_DURATION_MS;
  return ALLOWED_SURVEY_DURATION_MS.has(n) ? n : DEFAULT_SURVEY_DURATION_MS;
}

function normalizeSurveyDefinition(rawSurvey) {
  if (!rawSurvey || typeof rawSurvey !== "object") return null;
  const title = String(rawSurvey.title || "").trim();
  const question = String(rawSurvey.question || "").trim();
  if (!title || !question) return null;
  const activeDurationMs = normalizeSurveyDurationMs(
    rawSurvey.active_duration_ms != null ? rawSurvey.active_duration_ms : rawSurvey.duration_ms
  );
  const optionsRaw = Array.isArray(rawSurvey.options) ? rawSurvey.options : [];
  const options = optionsRaw.map((o, i) => {
    if (!o || typeof o !== "object") return null;
    const label = String(o.label || "").trim();
    if (!label) return null;
    return { key: String(o.key || slugify(label) || `opt_${i + 1}`), label };
  }).filter(Boolean);
  const idBase = String(rawSurvey.id || slugify(title) || "").trim();
  if (!idBase) return null;
  const revealRaw = rawSurvey.reveal_interval_ms;
  const revealIntervalMs = (typeof revealRaw === "number" && ALLOWED_REVEAL_INTERVALS.has(revealRaw)) ? revealRaw : null;
  const allowCustomOptions = rawSurvey.allow_custom_options !== false;
  return { id: idBase, title, question, activeDurationMs, options, revealIntervalMs, allowCustomOptions };
}

// ── Vote decryption (ECDH P-256 + AES-GCM) ─────────────────────────────────
function getSubtle() {
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle) return globalThis.crypto.subtle;
  // Node 16+ exposes webcrypto on require("crypto")
  const nodeCrypto = require("crypto");
  return nodeCrypto.webcrypto && nodeCrypto.webcrypto.subtle;
}

function _b64ToBuf(b64) {
  const s = String(b64).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, "base64");
}

function _bufToB64Url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function decryptVote(dBase64Url, pubKeyBase64, evBase64) {
  const subtle = getSubtle();
  if (!subtle) throw new Error("WebCrypto subtle unavailable");
  const combined = _b64ToBuf(evBase64);
  const iv = combined.slice(0, 12);
  const ephPub = combined.slice(12, 77);
  const ct = combined.slice(77);
  const serverPubBuf = _b64ToBuf(pubKeyBase64);
  const x = _bufToB64Url(serverPubBuf.slice(1, 33));
  const y = _bufToB64Url(serverPubBuf.slice(33, 65));
  const privKey = await subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x, y, d: dBase64Url },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const ephKey = await subtle.importKey(
    "raw", ephPub, { name: "ECDH", namedCurve: "P-256" }, false, [],
  );
  const shared = await subtle.deriveBits({ name: "ECDH", public: ephKey }, privKey, 256);
  const aesKey = await subtle.importKey("raw", shared, { name: "AES-GCM" }, false, ["decrypt"]);
  const plain = await subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ct);
  return Buffer.from(plain).toString("utf8");
}

async function decryptVoteMemos(rawTxs, parseAppTx) {
  const PUBKEY_MAP = new Map();
  const PRIVKEY_MAP = new Map();
  for (const raw of rawTxs) {
    const p = parseAppTx(raw);
    if (!p) continue;
    if (p.memo.type === "publish_pubkeys" && p.memo.keys && p.memo.survey) {
      const m = PUBKEY_MAP.get(p.memo.survey) || new Map();
      for (const [ki, pub] of Object.entries(p.memo.keys)) m.set(Number(ki), pub);
      PUBKEY_MAP.set(p.memo.survey, m);
    }
    if (p.memo.type === "reveal_key" && p.memo.survey != null && p.memo.ki != null && p.memo.d) {
      const m = PRIVKEY_MAP.get(p.memo.survey) || new Map();
      m.set(Number(p.memo.ki), p.memo.d);
      PRIVKEY_MAP.set(p.memo.survey, m);
    }
  }
  const result = [];
  for (const raw of rawTxs) {
    const p = parseAppTx(raw);
    if (!p || p.memo.type !== "vote" || !p.memo.ev || p.memo.ki == null) {
      result.push(raw);
      continue;
    }
    const surveyKeys = PRIVKEY_MAP.get(p.memo.survey);
    const dScalar = surveyKeys ? surveyKeys.get(Number(p.memo.ki)) : null;
    const pubMap = PUBKEY_MAP.get(p.memo.survey);
    const pub = pubMap ? pubMap.get(Number(p.memo.ki)) : null;
    if (!dScalar || !pub) { result.push(raw); continue; }
    try {
      const choice = await decryptVote(dScalar, pub, p.memo.ev);
      const newMemo = Object.assign({}, p.memo, { choice });
      delete newMemo.ev;
      result.push(Object.assign({}, raw, { memo: JSON.stringify(newMemo) }));
    } catch (_) {
      result.push(raw);
    }
  }
  return result;
}

// ── CPMM helpers (mirrors index.html) ───────────────────────────────────────
function cpmmTotalLiquidity(mkt) {
  if (!mkt || !mkt.pools) return 0;
  let sum = 0;
  for (const p of Object.values(mkt.pools)) {
    if (p && typeof p.yes === "number" && typeof p.no === "number") sum += p.yes + p.no;
  }
  return sum;
}

function addPoolLiquidity(pools, amount) {
  const total = Object.values(pools).reduce((s, p) => s + p.yes + p.no, 0);
  if (total <= 0 || amount <= 0) return;
  const scale = 1 + amount / total;
  for (const k of Object.keys(pools)) {
    pools[k] = { yes: pools[k].yes * scale, no: pools[k].no * scale };
  }
}

function distributeRefund(mkt, settlement) {
  for (const [pubkey, shares] of Object.entries(mkt.userShares)) {
    for (const [optKey, s] of Object.entries(shares)) {
      if (s <= 0) continue;
      const pool = mkt.pools[optKey];
      if (!pool) continue;
      let credits;
      if (CPMM.cpmmSellArbitrage && Object.keys(mkt.pools).length > 1) {
        const result = CPMM.cpmmSellArbitrage(mkt.pools, optKey, s);
        credits = result.creditsReceived;
        for (const pk of Object.keys(result.newPools)) mkt.pools[pk] = result.newPools[pk];
      } else if (CPMM.cpmmSellYes) {
        credits = CPMM.cpmmSellYes(pool, s);
      } else {
        continue;
      }
      if (credits > 0) settlement.payouts[pubkey] = (settlement.payouts[pubkey] || 0) + credits;
    }
  }
  for (const [pubkey, noShares] of Object.entries(mkt.userNoShares || {})) {
    for (const [optKey, s] of Object.entries(noShares)) {
      if (s <= 0) continue;
      const pool = mkt.pools[optKey];
      if (!pool) continue;
      let credits;
      if (CPMM.cpmmSellArbitrageNo && Object.keys(mkt.pools).length > 1) {
        const result = CPMM.cpmmSellArbitrageNo(mkt.pools, optKey, s);
        credits = result.creditsReceived;
        for (const pk of Object.keys(result.newPools)) mkt.pools[pk] = result.newPools[pk];
      } else if (CPMM.cpmmSellNo) {
        credits = CPMM.cpmmSellNo(pool, s);
      } else {
        continue;
      }
      if (credits > 0) settlement.payouts[pubkey] = (settlement.payouts[pubkey] || 0) + credits;
    }
  }
}

// ── Full state rebuild ─────────────────────────────────────────────────────
async function computeFullState(rawTxs, opts) {
  const appPubkey = opts.appPubkey;
  const adminPubkey = opts.adminPubkey || null;
  const genesisAccounts = opts.genesisAccounts instanceof Set
    ? opts.genesisAccounts
    : new Set(Array.isArray(opts.genesisAccounts) ? opts.genesisAccounts : []);
  const globalUsernames = opts.globalUsernames || {}; // pubkey → name
  const now = typeof opts.now === "number" ? opts.now : Date.now();

  const isGenesisGated = genesisAccounts.size > 0;
  const isGenesisAccount = (addr) => !isGenesisGated || genesisAccounts.has(addr);

  const parseAppTx = makeParseAppTx(appPubkey);

  // Decrypt encrypted votes against published reveal keys before parsing.
  const decryptedTxs = await decryptVoteMemos(rawTxs, parseAppTx);

  const parsed = [];
  for (const raw of decryptedTxs) { const p = parseAppTx(raw); if (p) parsed.push(p); }
  parsed.sort((a, b) => a.tx.ts - b.tx.ts);

  const GLOBAL_USERNAMES = new Map();
  const JOINED = new Set();
  const MARKETS = new Map();
  const SETTLEMENTS = new Map();
  const CREDIT_FLOWS = new Map();

  function getCreditFlow(pubkey) {
    let f = CREDIT_FLOWS.get(pubkey);
    if (!f) { f = { antes: 0, grossBets: 0, netSells: 0, payouts: 0, dividends: 0, creatorRewards: 0 }; CREDIT_FLOWS.set(pubkey, f); }
    return f;
  }
  function userBalance(pubkey) {
    if (!JOINED.has(pubkey)) return 0;
    const f = CREDIT_FLOWS.get(pubkey);
    if (!f) return INITIAL_CREDITS;
    return INITIAL_CREDITS - f.antes - f.grossBets + f.netSells + f.payouts + f.dividends + f.creatorRewards;
  }

  // --- Phase 1: Usernames ---
  const nameMap = new Map();
  for (const { tx, memo } of parsed) {
    if (memo.type !== "set_username") continue;
    const prev = nameMap.get(tx.from);
    if (!prev || tx.ts >= prev.ts) {
      nameMap.set(tx.from, { name: normalizeUsername(memo.username, deriveDefaultUsername(tx.from), tx.from), ts: tx.ts });
    }
  }
  for (const [addr, v] of nameMap) GLOBAL_USERNAMES.set(addr, v.name);
  for (const addr in globalUsernames) GLOBAL_USERNAMES.set(addr, globalUsernames[addr]);

  // --- Phase 2: Joins ---
  let _firstJoiner = null;
  let _firstJoinTs = Infinity;
  for (const { tx, memo } of parsed) {
    if (memo.type !== "join" || !isGenesisAccount(tx.from)) continue;
    JOINED.add(tx.from);
    if (tx.ts < _firstJoinTs) { _firstJoinTs = tx.ts; _firstJoiner = tx.from; }
  }

  // --- Phase 3: Surveys (admin-only, with rate limiting) ---
  const effectiveAdmin = adminPubkey || _firstJoiner;
  const allCreations = [];
  for (const { tx, memo } of parsed) {
    if (memo.type !== "create_survey") continue;
    if (!isGenesisAccount(tx.from)) continue;
    if (effectiveAdmin && tx.from !== effectiveAdmin) continue;
    const survey = normalizeSurveyDefinition(memo.survey);
    if (survey) allCreations.push({ survey, ts: tx.ts, from: tx.from });
  }
  allCreations.sort((a, b) => a.ts - b.ts);
  const creationsBySender = new Map();
  const latestCreated = new Map();
  for (const entry of allCreations) {
    const times = creationsBySender.get(entry.from) || [];
    const windowStart = entry.ts - SURVEY_COOLDOWN_MS;
    const recent = times.filter(t => t > windowStart);
    if (recent.length >= MAX_SURVEYS_PER_WINDOW) continue;
    recent.push(entry.ts);
    creationsBySender.set(entry.from, recent);
    const existing = latestCreated.get(entry.survey.id);
    if (!existing || entry.ts >= existing.ts) {
      latestCreated.set(entry.survey.id, { survey: entry.survey, ts: entry.ts, from: entry.from });
    }
  }
  const earlyResolves = new Map();
  for (const { tx, memo } of parsed) {
    if (memo.type !== "resolve_early") continue;
    const sv = memo.survey == null ? null : String(memo.survey);
    if (!sv) continue;
    const prev = earlyResolves.get(sv);
    if (!prev || tx.ts < prev) earlyResolves.set(sv, tx.ts);
  }
  const deletedSurveyIds = new Set();
  for (const { tx, memo } of parsed) {
    if (memo.type !== "delete_survey") continue;
    const sv = memo.survey == null ? null : String(memo.survey);
    if (!sv) continue;
    const isAdminSender = adminPubkey
      ? tx.from === adminPubkey
      : !!_firstJoiner && tx.from === _firstJoiner;
    if (isAdminSender) deletedSurveyIds.add(sv);
  }

  const SURVEYS = Array.from(latestCreated.values())
    .filter(x => !deletedSurveyIds.has(x.survey.id))
    .sort((a, b) => b.ts - a.ts)
    .map(x => {
      let expiresAtMs = x.ts + x.survey.activeDurationMs;
      const earlyResolve = earlyResolves.get(x.survey.id);
      if (earlyResolve && earlyResolve < expiresAtMs) expiresAtMs = earlyResolve;
      return {
        ...x.survey,
        createdBy: x.from,
        createdAtMs: x.ts,
        expiresAtMs,
        archived: now >= expiresAtMs,
      };
    });
  const SURVEYS_BY_ID = new Map();
  for (const s of SURVEYS) SURVEYS_BY_ID.set(s.id, s);

  // --- Phase 4: Custom options per survey ---
  const optionsBySurvey = new Map();
  for (const { tx, memo } of parsed) {
    if (memo.type !== "add_option") continue;
    if (!isGenesisAccount(tx.from)) continue;
    const sv = memo.survey == null ? null : String(memo.survey);
    const survey = SURVEYS_BY_ID.get(sv);
    if (!survey || !survey.allowCustomOptions) continue;
    if (survey.archived && tx.ts >= survey.expiresAtMs) continue;
    const optObj = memo.option && typeof memo.option === "object" ? memo.option : null;
    const label = optObj && optObj.label != null ? String(optObj.label).trim() : "";
    if (!label) continue;
    const key = (optObj && optObj.key != null ? String(optObj.key).trim() : slugify(label)) || `opt_${last6(tx.from)}_${String(tx.ts)}`;
    if (!optionsBySurvey.has(sv)) optionsBySurvey.set(sv, new Map());
    const senderMap = optionsBySurvey.get(sv);
    const prev = senderMap.get(tx.from);
    if (!prev || tx.ts < prev.ts) {
      senderMap.set(tx.from, { key, label, ts: tx.ts, from: tx.from });
    }
  }
  for (const survey of SURVEYS) {
    const senderMap = optionsBySurvey.get(survey.id);
    if (!senderMap) continue;
    const existing = new Map(survey.options.map(o => [o.key, o]));
    const added = Array.from(senderMap.values()).sort((a, b) => a.ts - b.ts);
    for (const it of added) {
      let key = it.key;
      if (existing.has(key)) key = `${key}_${last6(it.from)}`;
      if (existing.has(key)) key = `${key}_${String(it.ts).slice(-4)}`;
      existing.set(key, { key, label: it.label, userAdded: true, addedBy: it.from });
    }
    survey.options = Array.from(existing.values());
  }

  // --- Phase 5: Votes ---
  const voteMap = new Map();
  for (const { tx, memo } of parsed) {
    if (memo.type !== "vote") continue;
    if (!isGenesisAccount(tx.from)) continue;
    const sv = memo.survey == null ? null : String(memo.survey);
    const survey = SURVEYS_BY_ID.get(sv);
    if (!survey) continue;
    const ch = memo.choice != null ? String(memo.choice) : memo.vote != null ? String(memo.vote) : null;
    if (!ch || !survey.options.some(o => o.key === ch)) continue;
    const k = `${tx.from}:${sv}`;
    const prev = voteMap.get(k);
    if (!prev || tx.ts >= prev.ts) voteMap.set(k, { from: tx.from, survey: sv, choice: ch, ts: tx.ts });
  }

  // --- Phase 5b: Seed markets from creator ante (CPMM) ---
  for (const survey of SURVEYS) {
    if (!survey.createdBy || !JOINED.has(survey.createdBy)) continue;
    if (userBalance(survey.createdBy) < MARKET_ANTE) continue;
    const numOpts = survey.options.length;
    if (numOpts < 2) continue;
    const initPools = CPMM.cpmmInitPools ? CPMM.cpmmInitPools(MARKET_ANTE + PLATFORM_LIQUIDITY, numOpts) : [];
    if (initPools.length === 0) continue;
    const mkt = { pools: {}, userShares: {}, userNoShares: {}, feePool: 0, grossBetsByUser: {}, netSellsByUser: {}, creatorReward: 0, creator: survey.createdBy, history: [], optionVolume: {} };
    const seedPerOption = (MARKET_ANTE + PLATFORM_LIQUIDITY) / survey.options.length;
    for (let i = 0; i < survey.options.length; i++) {
      mkt.pools[survey.options[i].key] = { ...initPools[i] };
      mkt.optionVolume[survey.options[i].key] = seedPerOption;
    }
    MARKETS.set(survey.id, mkt);
    getCreditFlow(survey.createdBy).antes += MARKET_ANTE;
  }

  // --- Phase 6: Market operations (chronological replay) ---
  for (const { tx, memo } of parsed) {
    if (memo.type !== "place_bet" && memo.type !== "sell_shares") continue;
    const sv = memo.survey == null ? null : String(memo.survey);
    const survey = SURVEYS_BY_ID.get(sv);
    if (!survey) continue;
    if (tx.ts >= survey.expiresAtMs) continue;
    const optKey = memo.option == null ? null : String(memo.option);
    if (!optKey || !survey.options.some(o => o.key === optKey)) continue;
    if (!JOINED.has(tx.from)) continue;

    let mkt = MARKETS.get(sv);
    if (!mkt) {
      const numOpts = survey.options.length;
      const initPools = CPMM.cpmmInitPools ? CPMM.cpmmInitPools(MARKET_ANTE + PLATFORM_LIQUIDITY, numOpts) : [];
      mkt = { pools: {}, userShares: {}, userNoShares: {}, feePool: 0, grossBetsByUser: {}, netSellsByUser: {}, creatorReward: 0, creator: survey.createdBy || null, history: [], optionVolume: {} };
      if (initPools.length === numOpts) {
        const spo = (MARKET_ANTE + PLATFORM_LIQUIDITY) / numOpts;
        for (let i = 0; i < numOpts; i++) {
          mkt.pools[survey.options[i].key] = { ...initPools[i] };
          mkt.optionVolume[survey.options[i].key] = spo;
        }
      }
      MARKETS.set(sv, mkt);
    }

    if (memo.type === "place_bet") {
      const credits = typeof memo.credits === "number" ? memo.credits : Number(memo.credits);
      if (!Number.isFinite(credits) || credits < 1) continue;
      const bal = userBalance(tx.from);
      if (bal < credits) continue;
      const totalPoolValue = Object.values(mkt.pools).reduce((s, p) => s + p.yes + p.no, 0);
      const maxBet = Math.floor(totalPoolValue * MAX_BET_POOL_RATIO);
      if (credits > maxBet) continue;

      const fee = credits * FEE_RATE;
      const liquidityFee = credits * LIQUIDITY_FEE_RATE;
      const creatorCut = Math.min(credits * CREATOR_REWARD_RATE, CREATOR_REWARD_CAP - mkt.creatorReward);
      const voterFee = fee - Math.max(0, creatorCut) - liquidityFee;
      const net = credits - fee;

      const side = memo.side === "no" ? "no" : "yes";
      const pool = mkt.pools[optKey];
      if (!pool) continue;

      let res;
      if (side === "no") {
        if (!CPMM.cpmmArbitrageNo) continue;
        res = CPMM.cpmmArbitrageNo(mkt.pools, optKey, net);
      } else {
        if (!CPMM.cpmmArbitrage) continue;
        res = CPMM.cpmmArbitrage(mkt.pools, optKey, net);
      }
      if (res.sharesReceived <= 0) continue;

      for (const k of Object.keys(res.newPools)) mkt.pools[k] = res.newPools[k];
      addPoolLiquidity(mkt.pools, liquidityFee);
      if (side === "no") {
        if (!mkt.userNoShares[tx.from]) mkt.userNoShares[tx.from] = {};
        mkt.userNoShares[tx.from][optKey] = (mkt.userNoShares[tx.from][optKey] || 0) + res.sharesReceived;
      } else {
        if (!mkt.userShares[tx.from]) mkt.userShares[tx.from] = {};
        mkt.userShares[tx.from][optKey] = (mkt.userShares[tx.from][optKey] || 0) + res.sharesReceived;
      }
      mkt.feePool += voterFee;
      if (creatorCut > 0) {
        mkt.creatorReward += creatorCut;
        if (mkt.creator) getCreditFlow(mkt.creator).creatorRewards += creatorCut;
      }
      mkt.grossBetsByUser[tx.from] = (mkt.grossBetsByUser[tx.from] || 0) + credits;
      getCreditFlow(tx.from).grossBets += credits;
      mkt.optionVolume[optKey] = (mkt.optionVolume[optKey] || 0) + credits;
    }

    if (memo.type === "sell_shares") {
      const sharesToSell = typeof memo.shares === "number" ? memo.shares : Number(memo.shares);
      if (!Number.isFinite(sharesToSell) || sharesToSell <= 0) continue;
      const side = memo.side === "no" ? "no" : "yes";
      const userHeld = side === "no"
        ? ((mkt.userNoShares[tx.from] && mkt.userNoShares[tx.from][optKey]) || 0)
        : ((mkt.userShares[tx.from] && mkt.userShares[tx.from][optKey]) || 0);
      if (userHeld < sharesToSell) continue;
      const pool = mkt.pools[optKey];
      if (!pool) continue;

      let grossCredits;
      if (side === "no") {
        if (CPMM.cpmmSellArbitrageNo && Object.keys(mkt.pools).length > 1) {
          const result = CPMM.cpmmSellArbitrageNo(mkt.pools, optKey, sharesToSell);
          grossCredits = result.creditsReceived;
          if (grossCredits <= 0) continue;
          for (const pk of Object.keys(result.newPools)) mkt.pools[pk] = result.newPools[pk];
        } else if (CPMM.cpmmSellNo && CPMM.cpmmSellNoApply) {
          grossCredits = CPMM.cpmmSellNo(pool, sharesToSell);
          if (grossCredits <= 0) continue;
          mkt.pools[optKey] = CPMM.cpmmSellNoApply(pool, sharesToSell);
        } else {
          continue;
        }
      } else {
        if (CPMM.cpmmSellArbitrage && Object.keys(mkt.pools).length > 1) {
          const result = CPMM.cpmmSellArbitrage(mkt.pools, optKey, sharesToSell);
          grossCredits = result.creditsReceived;
          if (grossCredits <= 0) continue;
          for (const pk of Object.keys(result.newPools)) mkt.pools[pk] = result.newPools[pk];
        } else if (CPMM.cpmmSellYes && CPMM.cpmmSellYesApply) {
          grossCredits = CPMM.cpmmSellYes(pool, sharesToSell);
          if (grossCredits <= 0) continue;
          mkt.pools[optKey] = CPMM.cpmmSellYesApply(pool, sharesToSell);
        } else {
          continue;
        }
      }

      const fee = grossCredits * FEE_RATE;
      const liquidityFee = grossCredits * LIQUIDITY_FEE_RATE;
      const creatorCut = Math.min(grossCredits * CREATOR_REWARD_RATE, CREATOR_REWARD_CAP - mkt.creatorReward);
      const voterFee = fee - Math.max(0, creatorCut) - liquidityFee;
      const netCredits = grossCredits - fee;

      addPoolLiquidity(mkt.pools, liquidityFee);
      if (side === "no") {
        mkt.userNoShares[tx.from][optKey] = userHeld - sharesToSell;
      } else {
        mkt.userShares[tx.from][optKey] = userHeld - sharesToSell;
      }
      mkt.feePool += voterFee;
      if (creatorCut > 0) {
        mkt.creatorReward += creatorCut;
        if (mkt.creator) getCreditFlow(mkt.creator).creatorRewards += creatorCut;
      }
      mkt.netSellsByUser[tx.from] = (mkt.netSellsByUser[tx.from] || 0) + netCredits;
      getCreditFlow(tx.from).netSells += netCredits;
    }
  }

  // --- Phase 7: Settlement for expired surveys ---
  for (const survey of SURVEYS) {
    if (!survey.archived) continue;
    const mkt = MARKETS.get(survey.id);

    const voteCounts = {};
    for (const opt of survey.options) voteCounts[opt.key] = 0;
    const voterSet = new Set();
    for (const [, v] of voteMap) {
      if (v.survey !== survey.id) continue;
      voteCounts[v.choice] = (voteCounts[v.choice] || 0) + 1;
      voterSet.add(v.from);
    }

    const totalPool = mkt ? cpmmTotalLiquidity(mkt) : 0;
    const settlement = { winner: null, payouts: {}, voterDividendPer: 0, surprise: {}, totalPool, feePool: mkt ? mkt.feePool : 0, voteCounts, voterCount: voterSet.size, voters: voterSet };

    if (mkt && totalPool > 0) {
      settlement.feePool = mkt.feePool;
      const totalVotes = Object.values(voteCounts).reduce((a, b) => a + b, 0);

      for (const opt of survey.options) {
        const vs = totalVotes > 0 ? (voteCounts[opt.key] || 0) / totalVotes : 0;
        const pool = mkt.pools[opt.key];
        const mp = pool && CPMM.cpmmProb ? CPMM.cpmmProb(pool) : 0;
        settlement.surprise[opt.key] = vs - mp;
      }

      if (totalVotes === 0) {
        distributeRefund(mkt, settlement);
      } else {
        let maxVotes = 0;
        let winners = [];
        for (const [key, count] of Object.entries(voteCounts)) {
          if (count > maxVotes) { maxVotes = count; winners = [key]; }
          else if (count === maxVotes && count > 0) winners.push(key);
        }
        const K = winners.length;
        settlement.winners = winners;
        settlement.winner = K === 1 ? winners[0] : null;
        const weights = {};
        for (const opt of survey.options) weights[opt.key] = 0;
        for (const w of winners) weights[w] = 1 / K;
        settlement.resolutionWeights = weights;

        for (const [pubkey, shares] of Object.entries(mkt.userShares)) {
          for (const [optKey, s] of Object.entries(shares)) {
            const w = weights[optKey] || 0;
            if (w > 0 && s > 0) settlement.payouts[pubkey] = (settlement.payouts[pubkey] || 0) + s * w;
          }
        }

        if (voterSet.size > 0 && mkt.feePool > 0) {
          settlement.voterDividendPer = mkt.feePool / voterSet.size;
        }

        for (const [pubkey, amount] of Object.entries(settlement.payouts)) {
          getCreditFlow(pubkey).payouts += amount;
        }
        if (settlement.voterDividendPer > 0) {
          for (const voter of voterSet) {
            getCreditFlow(voter).dividends += settlement.voterDividendPer;
          }
        }
      }
    }

    SETTLEMENTS.set(survey.id, settlement);
  }

  // --- Phase 8: Leaderboard (Bet P&L) ---
  const earningsMap = new Map();
  for (const survey of SURVEYS) {
    if (!survey.archived) continue;
    const mkt = MARKETS.get(survey.id);
    if (!mkt || cpmmTotalLiquidity(mkt) <= 0) continue;
    const settlement = SETTLEMENTS.get(survey.id);
    if (!settlement) continue;
    const dividend = settlement.voterDividendPer || 0;
    for (const pubkey of Object.keys(mkt.grossBetsByUser)) {
      const grossBet = mkt.grossBetsByUser[pubkey] || 0;
      if (grossBet <= 0) continue;
      const netSells = mkt.netSellsByUser[pubkey] || 0;
      const payout = settlement.payouts[pubkey] || 0;
      const div = (settlement.voterCount > 0 && voteMap.has(pubkey + ":" + survey.id)) ? dividend : 0;
      const profit = payout + netSells + div - grossBet;
      const shares = mkt.userShares[pubkey] || {};
      const noShares = (mkt.userNoShares || {})[pubkey] || {};
      const sw = settlement.resolutionWeights || {};
      const hadWinningYes = Object.entries(shares).some(([k, s]) => s > 0 && (sw[k] || 0) > 0);
      const hadWinningNo = Object.entries(noShares).some(([k, s]) => s > 0 && (sw[k] || 0) < 1);
      const hadWinningShares = hadWinningYes || hadWinningNo;
      let e = earningsMap.get(pubkey);
      if (!e) { e = { totalEarnings: 0, marketsParticipated: 0, marketsWon: 0 }; earningsMap.set(pubkey, e); }
      e.marketsParticipated++;
      e.totalEarnings += profit;
      if (hadWinningShares && payout > 0) e.marketsWon++;
    }
  }

  return {
    GLOBAL_USERNAMES,
    JOINED,
    CREDIT_FLOWS,
    earningsMap,
    userBalance,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────
async function buildLeaderboard(rawTxs, opts) {
  const state = await computeFullState(rawTxs, opts);
  const { GLOBAL_USERNAMES, JOINED, CREDIT_FLOWS, earningsMap, userBalance } = state;

  // Union of every account that has interacted with the dapp (joined,
  // betted, voted, set a username, etc.) so callers see every player —
  // not just the subset on the Bet P&L leaderboard.
  const allPubkeys = new Set();
  for (const k of JOINED) allPubkeys.add(k);
  for (const k of GLOBAL_USERNAMES.keys()) allPubkeys.add(k);
  for (const k of CREDIT_FLOWS.keys()) allPubkeys.add(k);
  for (const k of earningsMap.keys()) allPubkeys.add(k);

  const users = [];
  for (const pubkey of allPubkeys) {
    const e = earningsMap.get(pubkey) || { totalEarnings: 0, marketsParticipated: 0, marketsWon: 0 };
    const winRate = e.marketsParticipated > 0 ? e.marketsWon / e.marketsParticipated : 0;
    const flow = CREDIT_FLOWS.get(pubkey) || null;
    users.push({
      pubkey,
      username: GLOBAL_USERNAMES.get(pubkey) || deriveDefaultUsername(pubkey),
      joined: JOINED.has(pubkey),
      credits: JOINED.has(pubkey) ? userBalance(pubkey) : 0,
      total_earnings: e.totalEarnings,
      markets_participated: e.marketsParticipated,
      markets_won: e.marketsWon,
      win_rate: winRate,
      credit_flow: flow ? {
        antes: flow.antes,
        gross_bets: flow.grossBets,
        net_sells: flow.netSells,
        payouts: flow.payouts,
        dividends: flow.dividends,
        creator_rewards: flow.creatorRewards,
      } : null,
    });
  }

  users.sort((a, b) => {
    if (b.total_earnings !== a.total_earnings) return b.total_earnings - a.total_earnings;
    if (b.credits !== a.credits) return b.credits - a.credits;
    return a.username.localeCompare(b.username);
  });

  return { users, count: users.length };
}

module.exports = {
  buildLeaderboard,
  computeFullState,
  // Constants exposed for parity assertions / tests
  INITIAL_CREDITS,
  MARKET_ANTE,
  PLATFORM_LIQUIDITY,
  FEE_RATE,
  LIQUIDITY_FEE_RATE,
  CREATOR_REWARD_RATE,
  CREATOR_REWARD_CAP,
};
