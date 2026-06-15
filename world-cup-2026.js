/**
 * World Cup 2026 Prediction Markets — server-side scheduler for Opinion Market.
 *
 * The football analog of daily-btc.js. Where daily-btc posts one server-
 * authored survey per UTC day, this module posts one server-authored survey
 * per World Cup 2026 match and resolves it against the authoritative
 * football-data.org result.
 *
 * Responsibilities (all idempotent, all on-chain in production):
 *   1. SEED GROUP STAGE — read the 72 group-stage fixtures from
 *      data/wc26-group-fixtures.json and post a `create_wc26_match` memo for
 *      each one that isn't already on-chain. Rate-limited to <=3 sends/min so
 *      the sidecar signer is never flooded.
 *   2. SEED KNOCKOUT — knockout fixtures aren't known up front (they depend on
 *      group results). Once football-data.org reports a knockout match with
 *      BOTH teams determined (not TBD), post a `create_wc26_match` for it. A
 *      deterministic matchId derived from the API match id keeps parallel
 *      deploys in agreement.
 *   3. RESOLVE — poll football-data.org every ~3 min. For each FINISHED match
 *      whose survey has no `resolve_wc26_match` on-chain yet, map the API
 *      result to one of the survey's option keys (home_win / draw / away_win)
 *      and post the resolution. POSTPONED / CANCELLED -> winnerKey "void"
 *      (Phase 7 refunds all bets).
 *   4. STATUS — getStatus() exposes seeded/resolved/pending counts, last poll
 *      time, and the last API error so "the tournament went dark" is
 *      observable on /health and /__wc26/status instead of silent.
 *
 * Determinism / idempotency (mirrors daily-btc.js):
 *   - matchId is the survey id. Group-stage ids come from the fixture file;
 *     knockout ids are `wc26-<stage>-<apiMatchId>`. A restart, a missed tick,
 *     or a second co-operating deploy sharing APP_PUBKEY all collapse to one
 *     survey in replay.
 *   - Before creating/resolving we read the live raw-tx feed and skip any
 *     memo already on-chain. Duplicate sends that still race through are
 *     reconciled by replay's earliest-memo-wins rule.
 *   - Replay (public/opinion-market-state.js) NEVER calls the football API —
 *     every result is read off the on-chain `resolve_wc26_match` memo, so
 *     client and server rebuilds always agree.
 */

"use strict";

const https = require("https");
const path = require("path");
const fs = require("fs");

const APP_ID = "opinion-market";
const HOUR_MS = 3600000;
// Survey stays active until kickoff + 8h: a generous window for extra time,
// VAR, penalties, and API result propagation, while still bounding lifetime.
const POST_KICKOFF_WINDOW_MS = 8 * HOUR_MS;

// football-data.org competition code for the FIFA World Cup. The free tier
// keys this as "WC". Overridable via opts.competitionCode for forward-compat
// if the provider re-codes the 2026 edition.
const DEFAULT_COMPETITION_CODE = "WC";
const FOOTBALL_DATA_HOST = "api.football-data.org";

// Resolution poll cadence. 3 min is well within the free tier's 10 req/min.
const RESOLVE_TICK_MS = 3 * 60 * 1000;
// Group-stage seeding cadence. One create per fire = ~2.86 sends/min, under
// the 3/min budget. Seeding all 72 takes ~24 min once, then no-ops.
const SEED_TICK_MS = 21 * 1000;
// Per-request HTTP timeout for the football API.
const API_HTTP_TIMEOUT_MS = 15000;

// Map football-data.org stage strings to our compact stage slugs. Knockout
// matches are two-way (no draw — ties resolve in ET/penalties and the API
// still reports a HOME_TEAM/AWAY_TEAM winner).
var KNOCKOUT_STAGES = {
  LAST_32: "r32",
  ROUND_OF_32: "r32",
  LAST_16: "r16",
  ROUND_OF_16: "r16",
  QUARTER_FINALS: "qf",
  QUARTER_FINAL: "qf",
  SEMI_FINALS: "sf",
  SEMI_FINAL: "sf",
  THIRD_PLACE: "third_place",
  THIRD_PLACE_PLAYOFF: "third_place",
  FINAL: "final",
};

function groupStageOptions() {
  return [
    { key: "home_win", label: "Home win" },
    { key: "draw", label: "Draw" },
    { key: "away_win", label: "Away win" },
  ];
}
function knockoutOptions() {
  return [
    { key: "home_win", label: "Home win" },
    { key: "away_win", label: "Away win" },
  ];
}

function stageDisplayName(stage) {
  switch (stage) {
    case "r32": return "Round of 32";
    case "r16": return "Round of 16";
    case "qf": return "Quarter-final";
    case "sf": return "Semi-final";
    case "third_place": return "Third-place play-off";
    case "final": return "Final";
    default: return "Knockout";
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t.unref) t.unref();
  });
}

// GET JSON with optional headers. Rejects on non-2xx, timeout, or bad JSON.
function httpGetJson(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: Object.assign({ accept: "application/json" }, headers || {}) }, (res) => {
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

function txTimestampMs(tx) {
  if (typeof tx.timestamp_ms === "number") return tx.timestamp_ms;
  if (typeof tx.created_at === "number") return tx.created_at;
  if (typeof tx.created_at === "string") {
    const t = Date.parse(tx.created_at);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

// Load the 72 group-stage fixtures, parsing ISO kickoffs into unix ms.
// Returns [] (and logs) if the file is missing/corrupt — the resolver/poller
// still run, the group-stage seed just no-ops.
function loadGroupFixtures() {
  const file = path.join(__dirname, "data", "wc26-group-fixtures.json");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`[wc26] failed to load fixtures (${file}): ${e.message}`);
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.fixtures) ? parsed.fixtures : [];
  const out = [];
  for (const f of list) {
    const kickoffMs = Date.parse(f.kickoffTime || f.kickoff || "");
    if (!f.matchId || Number.isNaN(kickoffMs)) continue;
    out.push({
      matchId: String(f.matchId),
      group: f.group ? String(f.group) : null,
      stage: "group",
      homeTeam: String(f.homeTeam || ""),
      awayTeam: String(f.awayTeam || ""),
      homeTeamName: String(f.homeTeamName || f.homeTeam || ""),
      awayTeamName: String(f.awayTeamName || f.awayTeam || ""),
      kickoffMs: kickoffMs,
      venue: f.venue ? String(f.venue) : "",
    });
  }
  return out;
}

// Build a `create_wc26_match` memo from a fixture descriptor + the send time.
// active_duration_ms is baked in so replay derives expiresAtMs = createdAtMs +
// active_duration_ms ≈ kickoff + 8h regardless of when the create landed.
function buildCreateMemo(fx, now) {
  const isGroup = fx.stage === "group";
  const options = isGroup ? groupStageOptions() : knockoutOptions();
  const title = `${fx.homeTeamName} vs ${fx.awayTeamName}`;
  const question = isGroup
    ? `${fx.homeTeamName} vs ${fx.awayTeamName} — home win, draw, or away win?`
    : `${fx.homeTeamName} vs ${fx.awayTeamName} — who advances?`;
  const activeDurationMs = Math.max(HOUR_MS, fx.kickoffMs - now + POST_KICKOFF_WINDOW_MS);
  return {
    app: APP_ID,
    type: "create_wc26_match",
    match: {
      id: fx.matchId,
      matchId: fx.matchId,
      title: title,
      question: question,
      options: options,
      kind: "wc26_match",
      stage: fx.stage,
      group: fx.group || null,
      home_team: fx.homeTeam,
      away_team: fx.awayTeam,
      home_team_name: fx.homeTeamName,
      away_team_name: fx.awayTeamName,
      kickoff_ms: fx.kickoffMs,
      venue: fx.venue || "",
      active_duration_ms: activeDurationMs,
      reveal_interval_ms: null,
    },
  };
}

// Scan the raw-tx feed for WC26 state. Returns:
//   created   Map<matchId, { matchId, stage, kickoffMs, options:[keys], txId }>
//   resolved  Set<matchId>
// Pure read — this is what makes seeding/resolving idempotent across restarts
// and the parallel-deploy topology.
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

    if (memo.type === "create_wc26_match" && memo.match && (memo.match.id || memo.match.matchId)) {
      const m = memo.match;
      const id = String(m.id || m.matchId);
      if (created.has(id)) continue;
      created.set(id, {
        matchId: id,
        stage: m.stage || "group",
        kickoffMs: typeof m.kickoff_ms === "number" ? m.kickoff_ms : null,
        options: Array.isArray(m.options) ? m.options.map(function (o) { return String(o.key); }) : [],
        txId: tx.tx_id || tx.id || null,
      });
    } else if (memo.type === "resolve_wc26_match" && (memo.matchId != null || (memo.match && memo.match.id))) {
      resolved.add(String(memo.matchId != null ? memo.matchId : memo.match.id));
    }
  }
  return { created, resolved };
}

function createWorldCup2026(opts) {
  const appPubkey = opts.appPubkey;
  const getRawTransactions = opts.getRawTransactions;
  const sendMemo = opts.sendMemo;
  const nowFn = opts.now || Date.now;
  const apiKey = opts.footballDataApiKey || opts.apiKey || "";
  const competitionCode = opts.competitionCode || DEFAULT_COMPETITION_CODE;
  // Staging-only: inject a create_wc26_match straight into the cache (bypassing
  // the chain) so the preview renders the full schedule even when staging has
  // no on-chain signer and no football API egress. Null in production.
  const seedTransaction = typeof opts.seedTransaction === "function" ? opts.seedTransaction : null;
  const senderPubkey = opts.senderPubkey || appPubkey;

  const fixtures = loadGroupFixtures();
  const fixtureById = new Map(fixtures.map(function (f) { return [f.matchId, f]; }));

  function teamPairKey(a, b) {
    return [String(a), String(b)].sort().join("|");
  }
  // Group fixtures indexed by unordered team-pair so an API match can be
  // mapped to our fixture regardless of the API's home/away orientation.
  const fixtureByPair = new Map();
  for (const f of fixtures) fixtureByPair.set(teamPairKey(f.homeTeam, f.awayTeam), f);

  let seedTimer = null;
  let resolveTimer = null;
  let stagingSeedTimer = null;
  let stopped = false;

  const status = {
    startedAt: null,
    fixtureCount: fixtures.length,
    lastSeedAt: null,
    lastResolveTickAt: null,
    lastApiPollAt: null,
    lastApiError: null,
    lastCreateId: null,
    lastResolveId: null,
    lastSendError: null,
    knockoutSeededCount: 0,
  };

  function countSeededGroup(created) {
    let n = 0;
    created.forEach(function (c) { if (fixtureById.has(c.matchId)) n++; });
    return n;
  }

  // ── Group-stage seeding ─────────────────────────────────────────────
  // Send at most ONE create per call (rate budget). Returns true if there was
  // a fixture to seed (whether or not the send itself succeeded).
  async function seedOneGroupMatch() {
    if (!fixtures.length) return false;
    const now = nowFn();
    let created;
    try { created = parseExisting(getRawTransactions, appPubkey).created; }
    catch (_) { created = new Map(); }

    for (const fx of fixtures) {
      if (created.has(fx.matchId)) continue;
      const memo = buildCreateMemo(fx, now);
      try {
        const ok = await sendMemo(memo);
        if (ok) {
          status.lastSeedAt = now;
          status.lastCreateId = fx.matchId;
          status.lastSendError = null;
          console.log(`[wc26] seeded ${fx.matchId} (${fx.homeTeam} v ${fx.awayTeam})`);
        } else {
          status.lastSendError = `create ${fx.matchId}: send rejected`;
          console.error(`[wc26] create send rejected (${fx.matchId}) — is SENDER_APP_SECRET_KEY configured?`);
        }
      } catch (e) {
        status.lastSendError = `create ${fx.matchId}: ${e.message}`;
        console.error(`[wc26] create send error (${fx.matchId}): ${e.message}`);
      }
      return true; // one per call, regardless of outcome (retry next tick)
    }
    return false; // nothing left to seed
  }

  // ── Football-data.org integration ───────────────────────────────────
  async function fetchApiMatches() {
    if (!apiKey) throw new Error("FOOTBALL_DATA_API_KEY not set");
    const url = `https://${FOOTBALL_DATA_HOST}/v4/competitions/${encodeURIComponent(competitionCode)}/matches`;
    const j = await httpGetJson(url, { "X-Auth-Token": apiKey }, API_HTTP_TIMEOUT_MS);
    return Array.isArray(j && j.matches) ? j.matches : [];
  }

  function normalizeApiMatch(m) {
    const home = m.homeTeam || {};
    const away = m.awayTeam || {};
    const score = m.score || {};
    return {
      apiId: m.id,
      stageRaw: m.stage || "",
      status: m.status || "",
      homeTla: (home.tla || "").toUpperCase(),
      awayTla: (away.tla || "").toUpperCase(),
      homeName: home.name || home.shortName || home.tla || "",
      awayName: away.name || away.shortName || away.tla || "",
      utcDate: m.utcDate || null,
      winner: score.winner || null, // HOME_TEAM | AWAY_TEAM | DRAW | null
    };
  }

  // Map an API result to one of OUR option keys for the given fixture, honoring
  // the fixture's home/away orientation (which may differ from the API's).
  function winnerKeyForFixture(fx, apiMatch) {
    if (apiMatch.status === "POSTPONED" || apiMatch.status === "CANCELLED" || apiMatch.status === "SUSPENDED") {
      return "void";
    }
    if (apiMatch.status !== "FINISHED") return null;
    if (apiMatch.winner === "DRAW") return fx.stage === "group" ? "draw" : null;
    const winTla = apiMatch.winner === "HOME_TEAM" ? apiMatch.homeTla
      : apiMatch.winner === "AWAY_TEAM" ? apiMatch.awayTla
      : null;
    if (!winTla) return null;
    if (winTla === fx.homeTeam) return "home_win";
    if (winTla === fx.awayTeam) return "away_win";
    return null;
  }

  // Knockout: derive a deterministic matchId + descriptor from an API match.
  function knockoutFixtureFromApi(apiMatch) {
    const stage = KNOCKOUT_STAGES[apiMatch.stageRaw];
    if (!stage) return null;
    if (!apiMatch.homeTla || !apiMatch.awayTla) return null; // teams not determined yet
    return {
      matchId: `wc26-${stage}-${apiMatch.apiId}`,
      group: null,
      stage: stage,
      homeTeam: apiMatch.homeTla,
      awayTeam: apiMatch.awayTla,
      homeTeamName: apiMatch.homeName,
      awayTeamName: apiMatch.awayName,
      kickoffMs: apiMatch.utcDate ? Date.parse(apiMatch.utcDate) : nowFn(),
      venue: "",
    };
  }

  async function resolveTick() {
    const now = nowFn();
    status.lastResolveTickAt = now;

    let existing;
    try { existing = parseExisting(getRawTransactions, appPubkey); }
    catch (_) { existing = { created: new Map(), resolved: new Set() }; }

    if (!apiKey) {
      status.lastApiError = "FOOTBALL_DATA_API_KEY not set";
      return getStatus();
    }

    let apiMatches;
    try {
      apiMatches = await fetchApiMatches();
      status.lastApiPollAt = now;
      status.lastApiError = null;
    } catch (e) {
      status.lastApiError = e.message;
      console.warn(`[wc26] football API poll failed: ${e.message}`);
      return getStatus();
    }

    for (const raw of apiMatches) {
      const am = normalizeApiMatch(raw);
      const isKnockout = !!KNOCKOUT_STAGES[am.stageRaw];

      // Determine which of OUR surveys this API match corresponds to.
      let fx = null;
      if (isKnockout) {
        fx = knockoutFixtureFromApi(am);
        // Knockout seeding: create the survey once both teams are known.
        if (fx && !existing.created.has(fx.matchId)) {
          const memo = buildCreateMemo(fx, now);
          try {
            const ok = await sendMemo(memo);
            if (ok) {
              existing.created.set(fx.matchId, {
                matchId: fx.matchId, stage: fx.stage, kickoffMs: fx.kickoffMs,
                options: knockoutOptions().map(function (o) { return o.key; }), txId: null,
              });
              status.knockoutSeededCount++;
              status.lastCreateId = fx.matchId;
              console.log(`[wc26] seeded knockout ${fx.matchId} (${fx.homeTeam} v ${fx.awayTeam})`);
            }
          } catch (e) {
            status.lastSendError = `create ${fx.matchId}: ${e.message}`;
            console.error(`[wc26] knockout create error (${fx.matchId}): ${e.message}`);
          }
        }
      } else {
        // Group stage: map by unordered team pair.
        fx = fixtureByPair.get(teamPairKey(am.homeTla, am.awayTla)) || null;
      }
      if (!fx) continue;
      if (existing.resolved.has(fx.matchId)) continue;
      if (!existing.created.has(fx.matchId)) continue; // not seeded yet → resolve later

      const winnerKey = winnerKeyForFixture(fx, am);
      if (winnerKey == null) continue; // not finished / unmappable
      // Validate against the survey's defined options (void always allowed).
      const optKeys = existing.created.get(fx.matchId).options || [];
      if (winnerKey !== "void" && optKeys.length && optKeys.indexOf(winnerKey) === -1) {
        console.warn(`[wc26] winner ${winnerKey} not an option of ${fx.matchId}; skipping`);
        continue;
      }

      const memo = {
        app: APP_ID,
        type: "resolve_wc26_match",
        matchId: fx.matchId,
        winnerKey: winnerKey,
        source: "football-data-api",
        resolved_at: now,
      };
      try {
        const ok = await sendMemo(memo);
        if (ok) {
          existing.resolved.add(fx.matchId);
          status.lastResolveId = fx.matchId;
          status.lastSendError = null;
          console.log(`[wc26] resolved ${fx.matchId} -> ${winnerKey}`);
        } else {
          status.lastSendError = `resolve ${fx.matchId}: send rejected`;
        }
      } catch (e) {
        status.lastSendError = `resolve ${fx.matchId}: ${e.message}`;
        console.error(`[wc26] resolve send error (${fx.matchId}): ${e.message}`);
      }
    }
    return getStatus();
  }

  // ── Staging seed (cache-only, no signer / no API needed) ────────────
  // Inject every group fixture directly into the cache so the preview renders
  // the whole schedule. Idempotent: deterministic per-match tx ids let the
  // cache dedup re-injections. Re-run on a cadence so it survives a chain reset.
  // Also injects resolve_wc26_match memos for past-kickoff matches and
  // sample vote memos from 5 staging predictors so the Standings screen
  // renders populated data.
  async function seedStaging() {
    if (!seedTransaction || !fixtures.length) return getStatus();
    const now = nowFn();
    let existing;
    try { existing = parseExisting(getRawTransactions, appPubkey); }
    catch (_) { existing = { created: new Map(), resolved: new Set() }; }
    const { created, resolved } = existing;

    // 1. Create memos for unseeded fixtures.
    let injected = 0;
    for (const fx of fixtures) {
      if (created.has(fx.matchId)) continue;
      const memo = buildCreateMemo(fx, now);
      const seedTxId = "staging-seed-" + fx.matchId;
      const tx = {
        tx_id: seedTxId,
        id: seedTxId,
        from_pubkey: senderPubkey,
        destination_pubkey: appPubkey,
        amount: 1,
        memo: JSON.stringify(memo),
        created_at: new Date(now).toISOString(),
      };
      try { seedTransaction(tx); injected++; created.set(fx.matchId, { matchId: fx.matchId, stage: fx.stage, kickoffMs: fx.kickoffMs, options: groupStageOptions().map(function (o) { return o.key; }) }); }
      catch (e) { console.error(`[wc26] staging seed error (${fx.matchId}): ${e.message}`); }
    }
    if (injected > 0) {
      status.lastSeedAt = now;
      console.log(`[wc26] staging-seeded ${injected} group fixtures`);
    }

    // 2. Resolve memos for past-kickoff fixtures (deterministic fake results).
    // WinnerKey chosen by matchId hash mod 3 (group: home_win/draw/away_win)
    // or mod 2 (knockout: home_win/away_win) to produce varied outcomes.
    const GROUP_OPTIONS = ["home_win", "draw", "away_win"];
    const KNOCKOUT_OPTIONS = ["home_win", "away_win"];
    function deterministicWinner(matchId, stage) {
      var h = 0;
      for (var ci = 0; ci < matchId.length; ci++) h = (h * 31 + matchId.charCodeAt(ci)) >>> 0;
      var opts = stage === "group" ? GROUP_OPTIONS : KNOCKOUT_OPTIONS;
      return opts[h % opts.length];
    }
    var pastFixtures = fixtures.filter(function (fx) { return fx.kickoffMs < now; });
    var resolveInjected = 0;
    for (var ri = 0; ri < pastFixtures.length; ri++) {
      var rfx = pastFixtures[ri];
      if (resolved.has(rfx.matchId)) continue;
      if (!created.has(rfx.matchId)) continue;
      var winnerKey = deterministicWinner(rfx.matchId, rfx.stage);
      var resolveMemo = {
        app: APP_ID,
        type: "resolve_wc26_match",
        matchId: rfx.matchId,
        winnerKey: winnerKey,
        source: "staging-seed",
        resolved_at: rfx.kickoffMs + 8 * HOUR_MS,
      };
      var resolveTxId = "staging-resolve-" + rfx.matchId;
      var resolveTx = {
        tx_id: resolveTxId,
        id: resolveTxId,
        from_pubkey: senderPubkey,
        destination_pubkey: appPubkey,
        amount: 1,
        memo: JSON.stringify(resolveMemo),
        created_at: new Date(rfx.kickoffMs + 8 * HOUR_MS).toISOString(),
      };
      try { seedTransaction(resolveTx); resolveInjected++; resolved.add(rfx.matchId); }
      catch (e) { console.error(`[wc26] staging resolve seed error (${rfx.matchId}): ${e.message}`); }
    }
    if (resolveInjected > 0) {
      console.log(`[wc26] staging-seeded ${resolveInjected} match resolutions`);
    }

    // 3. Staging predictor join + vote seeds (5 users, up to 8 settled matches).
    // Votes use pre-decrypted format (choice set directly, no ev field) — the
    // decryptVoteMemos guard in opinion-market-state.js passes these through.
    var STAGING_PREDICTORS = [
      { pubkey: "staging-predictor-1", username: "staging-demo-alfie" },
      { pubkey: "staging-predictor-2", username: "staging-demo-billie" },
      { pubkey: "staging-predictor-3", username: "staging-demo-casey" },
      { pubkey: "staging-predictor-4", username: "staging-demo-drew" },
      { pubkey: "staging-predictor-5", username: "staging-demo-emery" },
    ];
    // Determine which matches are resolved so we can seed votes for them.
    var resolvedPast = pastFixtures.filter(function (fx) { return resolved.has(fx.matchId); }).slice(0, 8);

    // Inject join memo for each staging predictor (idempotent via tx_id).
    for (var pi = 0; pi < STAGING_PREDICTORS.length; pi++) {
      var pred = STAGING_PREDICTORS[pi];
      var joinTxId = "staging-join-" + pred.pubkey;
      var joinTx = {
        tx_id: joinTxId, id: joinTxId,
        from_pubkey: pred.pubkey,
        destination_pubkey: appPubkey,
        amount: 1,
        memo: JSON.stringify({ app: APP_ID, type: "join" }),
        created_at: new Date(now - 30 * 24 * HOUR_MS).toISOString(),
      };
      var usernameTxId = "staging-username-" + pred.pubkey;
      var usernameTx = {
        tx_id: usernameTxId, id: usernameTxId,
        from_pubkey: pred.pubkey,
        destination_pubkey: appPubkey,
        amount: 1,
        memo: JSON.stringify({ app: APP_ID, type: "set_username", username: pred.username }),
        created_at: new Date(now - 30 * 24 * HOUR_MS + 1000).toISOString(),
      };
      try { seedTransaction(joinTx); } catch (_) {}
      try { seedTransaction(usernameTx); } catch (_) {}
    }

    // Inject vote memos for each predictor on each resolved past match.
    // Choice varies per predictor+match to produce a range of accuracy rates.
    var voteInjected = 0;
    for (var vi = 0; vi < resolvedPast.length; vi++) {
      var vfx = resolvedPast[vi];
      var actualWinner = deterministicWinner(vfx.matchId, vfx.stage);
      var opts = vfx.stage === "group" ? GROUP_OPTIONS : KNOCKOUT_OPTIONS;
      for (var vpi = 0; vpi < STAGING_PREDICTORS.length; vpi++) {
        var vpred = STAGING_PREDICTORS[vpi];
        var voteTxId = "staging-vote-" + vpred.pubkey + "-" + vfx.matchId;
        // Each predictor gets their own offset so accuracy rates differ.
        var choiceIdx = (vi + vpi * 2) % opts.length;
        // Predictors 0 and 1 are mostly correct; others vary.
        if (vpi <= 1) choiceIdx = opts.indexOf(actualWinner) !== -1 ? (vi % 2 === 0 ? opts.indexOf(actualWinner) : choiceIdx) : choiceIdx;
        var voteMemo = {
          app: APP_ID,
          type: "vote",
          survey: vfx.matchId,
          choice: opts[choiceIdx],
          ki: 0,
        };
        var voteTx = {
          tx_id: voteTxId, id: voteTxId,
          from_pubkey: vpred.pubkey,
          destination_pubkey: appPubkey,
          amount: 1,
          memo: JSON.stringify(voteMemo),
          created_at: new Date(vfx.kickoffMs - HOUR_MS).toISOString(),
        };
        try { seedTransaction(voteTx); voteInjected++; }
        catch (e) { console.error(`[wc26] staging vote seed error (${voteTxId}): ${e.message}`); }
      }
    }
    if (voteInjected > 0) {
      console.log(`[wc26] staging-seeded ${voteInjected} predictor votes`);
    }

    return getStatus();
  }

  function safeSeedStaging() {
    return seedStaging().catch(function (e) {
      console.error(`[wc26] staging seed error: ${e.message}`);
      return getStatus();
    });
  }

  // Manual one-shot: seed every missing group fixture (ignoring the per-tick
  // rate budget) and run one resolve poll. Used by POST /__wc26/tick.
  async function tick() {
    if (seedTransaction) {
      await safeSeedStaging();
    } else {
      for (let i = 0; i < fixtures.length; i++) {
        const sent = await seedOneGroupMatch();
        if (!sent) break;
        await delay(400);
      }
    }
    await resolveTick().catch(function (e) {
      console.error(`[wc26] resolve tick error: ${e.message}`);
    });
    return getStatus();
  }

  function getStatus() {
    let seeded = 0;
    let resolved = 0;
    try {
      const ex = parseExisting(getRawTransactions, appPubkey);
      seeded = countSeededGroup(ex.created);
      resolved = ex.resolved.size;
    } catch (_) { /* best-effort */ }
    return {
      startedAt: status.startedAt,
      fixtureCount: status.fixtureCount,
      groupSeeded: seeded,
      groupTotal: fixtures.length,
      knockoutSeeded: status.knockoutSeededCount,
      resolvedCount: resolved,
      pendingResolution: Math.max(0, seeded + status.knockoutSeededCount - resolved),
      apiConfigured: !!apiKey,
      competitionCode: competitionCode,
      lastSeedAt: status.lastSeedAt,
      lastResolveTickAt: status.lastResolveTickAt,
      lastApiPollAt: status.lastApiPollAt,
      lastApiError: status.lastApiError,
      lastCreateId: status.lastCreateId,
      lastResolveId: status.lastResolveId,
      lastSendError: status.lastSendError,
    };
  }

  // Lightweight schedule re-parse off the raw-tx cache (no full state rebuild),
  // for GET /__wc26/schedule.
  function getSchedule() {
    const txs = (getRawTransactions && getRawTransactions()) || [];
    const matches = new Map();
    const resolutions = new Map();
    for (const tx of txs) {
      const to = tx.destination_pubkey || tx.to || tx.destination;
      if (to !== appPubkey) continue;
      let memo;
      try { memo = typeof tx.memo === "string" ? JSON.parse(tx.memo) : tx.memo; }
      catch (_) { continue; }
      if (!memo || memo.app !== APP_ID) continue;
      if (memo.type === "create_wc26_match" && memo.match && (memo.match.id || memo.match.matchId)) {
        const m = memo.match;
        const id = String(m.id || m.matchId);
        if (matches.has(id)) continue;
        matches.set(id, {
          matchId: id,
          stage: m.stage || "group",
          group: m.group || null,
          homeTeam: m.home_team || "",
          awayTeam: m.away_team || "",
          homeTeamName: m.home_team_name || m.home_team || "",
          awayTeamName: m.away_team_name || m.away_team || "",
          kickoffMs: typeof m.kickoff_ms === "number" ? m.kickoff_ms : null,
          venue: m.venue || "",
          createdAtMs: txTimestampMs(tx),
          options: Array.isArray(m.options) ? m.options : [],
        });
      } else if (memo.type === "resolve_wc26_match" && (memo.matchId != null || (memo.match && memo.match.id))) {
        resolutions.set(String(memo.matchId != null ? memo.matchId : memo.match.id), memo.winnerKey != null ? String(memo.winnerKey) : null);
      }
    }
    const out = [];
    matches.forEach(function (m) {
      out.push(Object.assign({}, m, {
        resolved: resolutions.has(m.matchId),
        winnerKey: resolutions.has(m.matchId) ? resolutions.get(m.matchId) : null,
      }));
    });
    out.sort(function (a, b) { return (a.kickoffMs || 0) - (b.kickoffMs || 0); });
    return { matches: out, lastUpdated: nowFn() };
  }

  function start() {
    status.startedAt = nowFn();

    if (seedTransaction) {
      // Staging: seed the full schedule into the cache and keep re-seeding so
      // it survives a chain reset. No signer / API path runs.
      const seedWarmup = setTimeout(function () { safeSeedStaging(); }, 3000);
      if (seedWarmup.unref) seedWarmup.unref();
      stagingSeedTimer = setInterval(function () { safeSeedStaging(); }, 2 * 60 * 1000);
      if (stagingSeedTimer.unref) stagingSeedTimer.unref();
      console.log(`[wc26] staging seed enabled (${fixtures.length} fixtures)`);
      return;
    }

    // Production: rate-limited group-stage seed loop (one create per fire).
    const seedWarmup = setTimeout(function () { seedOneGroupMatch().catch(function () {}); }, 12000);
    if (seedWarmup.unref) seedWarmup.unref();
    seedTimer = setInterval(function () {
      seedOneGroupMatch().catch(function (e) { console.error(`[wc26] seed tick error: ${e.message}`); });
    }, SEED_TICK_MS);
    if (seedTimer.unref) seedTimer.unref();

    // Resolution poll loop.
    const resolveWarmup = setTimeout(function () {
      resolveTick().catch(function (e) { console.error(`[wc26] resolve tick error: ${e.message}`); });
    }, 20000);
    if (resolveWarmup.unref) resolveWarmup.unref();
    resolveTimer = setInterval(function () {
      resolveTick().catch(function (e) { console.error(`[wc26] resolve tick error: ${e.message}`); });
    }, RESOLVE_TICK_MS);
    if (resolveTimer.unref) resolveTimer.unref();

    console.log(`[wc26] scheduler started (${fixtures.length} group fixtures, resolve poll every ${Math.round(RESOLVE_TICK_MS / 60000)}m, api ${apiKey ? "configured" : "NOT configured"})`);
  }

  function stop() {
    stopped = true;
    if (seedTimer) clearInterval(seedTimer);
    if (resolveTimer) clearInterval(resolveTimer);
    if (stagingSeedTimer) clearInterval(stagingSeedTimer);
  }

  return {
    start,
    stop,
    tick: tick,
    seedStaging: safeSeedStaging,
    getStatus,
    getSchedule,
    getFixtures: function () { return fixtures.slice(); },
    _parseExisting: function () { return parseExisting(getRawTransactions, appPubkey); },
  };
}

module.exports = createWorldCup2026;
module.exports.loadGroupFixtures = loadGroupFixtures;
