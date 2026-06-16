/**
 * Daily Hot News Poll — server-side scheduler for Opinion Market.
 *
 * Each UTC day this module:
 *   1. Fetches the day's top headline from the Hacker News Firebase API
 *      (https://hacker-news.firebaseio.com — completely free, no API key).
 *   2. Sends the headline to the platform LLM proxy (USERNODE_LLM_PROXY_URL /
 *      USERNODE_LLM_PROXY_TOKEN) to generate a neutral binary yes/no poll
 *      question. The proxy is the platform's own Claude relay — no API key is
 *      stored per-app; the proxy handles billing.
 *   3. Posts a `create_daily_news` memo on-chain so the poll is pinned to the
 *      top of the Opinion Market feed for 24 hours.
 *
 * Resilience:
 *   - Fires at UTC midnight + 90 seconds (30 s after daily-btc's offset so
 *     the two schedulers don't race for the signer at the same instant).
 *   - A 45-minute safety tick re-attempts if the midnight call fails.
 *   - Survey IDs are deterministic per UTC day (`news-daily-YYYY-MM-DD`), so
 *     restarts, safety ticks, and parallel deploys all collapse to one survey.
 *   - If the LLM proxy is unavailable, each tick logs a warning and exits
 *     early — no poll for that day. In staging, seedStaging() first tries to
 *     fetch a real headline from Hacker News and falls back to a hardcoded
 *     question only if the network is unreachable.
 *
 * Two-server dedup:
 *   Both co-operating servers independently call the HN API and the LLM at
 *   midnight, so they may produce slightly different questions for the same
 *   day. The EARLIEST-memo-wins tie-break in Phase 3d of opinion-market-state.js
 *   resolves this: whichever server's `create_daily_news` tx lands on-chain
 *   first is canonical; the later tx is silently ignored during replay.
 */

"use strict";

const http = require("http");
const https = require("https");

const APP_ID = "opinion-market";
const DAY_MS = 86400000;
// Fire 90 s after UTC midnight — 30 s after daily-btc's 60 s offset.
const POST_MIDNIGHT_OFFSET_MS = 90 * 1000;
const SAFETY_TICK_MS = 45 * 60 * 1000;
// Re-seed staging every 2 minutes so the demo question survives a cache reset.
const STAGING_SEED_INTERVAL_MS = 2 * 60 * 1000;
const HTTP_TIMEOUT_MS = 15000;
const LLM_TIMEOUT_MS = 30000;

// Hacker News Firebase API — no API key required.
const HN_TOP_STORIES_URL = "https://hacker-news.firebaseio.com/v0/topstories.json";
const HN_ITEM_URL = "https://hacker-news.firebaseio.com/v0/item/";
// How many top stories to try before giving up (skips Ask HN / Show HN).
const HN_CANDIDATE_COUNT = 10;

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

function delay(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t.unref) t.unref();
  });
}

// Generic HTTP request — handles both http:// and https:// URLs.
// method: "GET" or "POST". body: object (JSON-serialised) or null.
// Returns the parsed JSON response body.
function httpRequest(method, url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const urlParsed = new URL(url);
    const isHttps = urlParsed.protocol === "https:";
    const mod = isHttps ? https : http;
    const bodyBuf = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const opts = {
      hostname: urlParsed.hostname,
      port: urlParsed.port || (isHttps ? 443 : 80),
      path: urlParsed.pathname + (urlParsed.search || ""),
      method,
      headers: Object.assign(
        { accept: "application/json" },
        bodyBuf
          ? { "content-type": "application/json", "content-length": bodyBuf.length }
          : {},
        headers || {}
      ),
    };
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const snippet = Buffer.concat(chunks).toString().slice(0, 300);
          return reject(new Error(`HTTP ${res.statusCode}: ${snippet}`));
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
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// Fetch today's top headline from the Hacker News Firebase API (no key needed).
// Returns { title, url, sourceName } or throws.
async function fetchHeadline() {
  const ids = await httpRequest("GET", HN_TOP_STORIES_URL, {}, null, HTTP_TIMEOUT_MS);
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("HN topstories returned no IDs");
  }
  const candidates = ids.slice(0, HN_CANDIDATE_COUNT);
  for (const storyId of candidates) {
    const story = await httpRequest(
      "GET",
      HN_ITEM_URL + storyId + ".json",
      {},
      null,
      HTTP_TIMEOUT_MS
    );
    if (
      story &&
      story.type === "story" &&
      typeof story.title === "string" &&
      story.title.trim() &&
      typeof story.url === "string" &&
      story.url.trim()
    ) {
      let sourceName = "Hacker News";
      try {
        const parsed = new URL(story.url);
        sourceName = parsed.hostname.replace(/^www\./, "");
      } catch (_) {}
      return {
        title: story.title.trim(),
        url: story.url.trim(),
        sourceName,
      };
    }
  }
  throw new Error("no usable story found in HN top stories");
}

// Generate a binary poll question from a headline via the platform LLM proxy.
// Returns { question, optionYes, optionNo } or throws.
async function generatePollQuestion(headline, llmProxyUrl, llmProxyToken) {
  const systemPrompt =
    "You are a neutral poll question writer. Given a news headline, produce a concise " +
    "binary yes/no opinion poll question about the core topic. Rules:\n" +
    "- Must be answerable with Yes or No.\n" +
    "- Frame neutrally — do not lead or editorialize.\n" +
    "- Keep under 100 characters.\n" +
    "- Avoid questions about individual personal tragedies.\n" +
    'Respond ONLY with valid JSON: {"question": "...", "yes": "Yes", "no": "No"}';

  const resp = await httpRequest(
    "POST",
    `${llmProxyUrl}/v1/messages`,
    {
      "anthropic-version": "2023-06-01",
      "x-usernode-app-token": llmProxyToken,
    },
    {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Headline: ${headline}\n\nGenerate the poll question JSON.`,
        },
      ],
    },
    LLM_TIMEOUT_MS
  );

  const content = resp.content && Array.isArray(resp.content) ? resp.content : [];
  const textBlock = content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("no text block in LLM response");

  // Strip markdown code fences if the model wraps its JSON.
  const raw = textBlock.text.trim();
  const jsonStr = raw.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`LLM returned non-JSON: ${raw.slice(0, 100)}`);
  }

  if (typeof parsed.question !== "string" || !parsed.question.trim()) {
    throw new Error("LLM returned missing or empty question field");
  }

  return {
    question: parsed.question.trim(),
    optionYes: (typeof parsed.yes === "string" ? parsed.yes : "Yes").trim() || "Yes",
    optionNo: (typeof parsed.no === "string" ? parsed.no : "No").trim() || "No",
  };
}

// Scan the raw-tx feed for daily-news survey IDs that already exist on-chain.
// Pure read — makes the tick idempotent across restarts and parallel deploys.
function parseExisting(getRawTransactions, appPubkey) {
  const created = new Set();
  const txs = (getRawTransactions && getRawTransactions()) || [];
  for (const tx of txs) {
    const to = tx.destination_pubkey || tx.to || tx.destination;
    if (to !== appPubkey) continue;
    let memo;
    try {
      memo = typeof tx.memo === "string" ? JSON.parse(tx.memo) : tx.memo;
    } catch (_) {
      continue;
    }
    if (!memo || memo.app !== APP_ID) continue;
    if (memo.type === "create_daily_news" && memo.survey && memo.survey.id) {
      created.add(String(memo.survey.id));
    }
  }
  return { created };
}

// Build the canonical `create_daily_news` memo. Shared by the live tick and
// the staging seed so both produce the same survey definition shape.
function buildCreateMemo(id, question, optionYes, optionNo, headline, sourceUrl, sourceName, now) {
  return {
    app: APP_ID,
    type: "create_daily_news",
    survey: {
      id,
      title: "Today's Hot Topic",
      question,
      options: [
        { key: "yes", label: optionYes },
        { key: "no", label: optionNo },
      ],
      active_duration_ms: DAY_MS,
      reveal_interval_ms: null,
      allow_custom_options: false,
      kind: "news_poll",
      headline,
      source_url: sourceUrl,
      source_name: sourceName,
      created_at: now,
    },
  };
}

function createDailyNews(opts) {
  const appPubkey = opts.appPubkey;
  const getRawTransactions = opts.getRawTransactions;
  const sendMemo = opts.sendMemo;
  const nowFn = opts.now || Date.now;
  // Staging-only: inject a raw tx straight into the cache's raw-tx feed
  // (bypassing the chain). Null/undefined in production.
  const seedTransaction =
    typeof opts.seedTransaction === "function" ? opts.seedTransaction : null;
  const senderPubkey = opts.senderPubkey || appPubkey;

  // Platform LLM proxy — injected by the platform, never in dapp.json.
  const llmProxyUrl = process.env.USERNODE_LLM_PROXY_URL || "";
  const llmProxyToken = process.env.USERNODE_LLM_PROXY_TOKEN || "";
  const llmEnabled = !!(llmProxyUrl && llmProxyToken);

  let midnightTimer = null;
  let safetyTimer = null;
  let stagingSeedTimer = null;
  let stopped = false;

  // In-memory observability. Surfaced via getStatus() on /health and the
  // manual-trigger route so "no poll today" is detectable without grepping logs.
  const status = {
    startedAt: null,
    lastTickAt: null,
    lastCreateAt: null,
    lastCreateId: null,
    lastHeadline: null,
    lastFetchError: null,
    lastSendError: null,
  };

  async function tick() {
    const now = nowFn();
    status.lastTickAt = now;

    if (!llmEnabled) {
      return getStatus();
    }

    const { created } = parseExisting(getRawTransactions, appPubkey);
    const id = "news-daily-" + utcDayId(now);

    if (created.has(id)) {
      return getStatus(); // idempotent: already exists on-chain
    }

    // 1) Fetch headline.
    let headline;
    try {
      headline = await fetchHeadline();
      status.lastHeadline = headline.title;
      status.lastFetchError = null;
    } catch (e) {
      status.lastFetchError = `headline: ${e.message}`;
      console.warn(`[daily-news] headline fetch failed, skipping tick: ${e.message}`);
      return getStatus();
    }

    // 2) Generate poll question via LLM proxy.
    let poll;
    try {
      poll = await generatePollQuestion(headline.title, llmProxyUrl, llmProxyToken);
      status.lastFetchError = null;
    } catch (e) {
      status.lastFetchError = `LLM: ${e.message}`;
      console.warn(`[daily-news] LLM question generation failed, skipping tick: ${e.message}`);
      return getStatus();
    }

    // 3) Post on-chain.
    const memo = buildCreateMemo(
      id,
      poll.question,
      poll.optionYes,
      poll.optionNo,
      headline.title,
      headline.url,
      headline.sourceName,
      now
    );
    try {
      const ok = await sendMemo(memo);
      if (ok) {
        status.lastCreateAt = now;
        status.lastCreateId = id;
        status.lastSendError = null;
        console.log(`[daily-news] created ${id}: "${poll.question}"`);
      } else {
        status.lastSendError = `create ${id}: send rejected`;
        console.error(
          `[daily-news] create send rejected (${id}) — is SENDER_APP_SECRET_KEY configured?`
        );
      }
    } catch (e) {
      status.lastSendError = `create ${id}: ${e.message}`;
      console.error(`[daily-news] create send error (${id}): ${e.message}`);
    }

    return getStatus();
  }

  function safeTick() {
    return tick().catch((e) => {
      console.error(`[daily-news] tick error: ${e.message}`);
      return getStatus();
    });
  }

  // Staging-only seed. Tries to fetch a real Hacker News headline first; falls
  // back to a hardcoded question only if the HN API is unreachable. Either way,
  // injects a `create_daily_news` tx directly into the cache's raw-tx feed via
  // `seedTransaction` so the preview renders a news poll even when the LLM proxy
  // is unavailable.
  // Idempotent: deterministic per-day tx id lets the cache dedup re-injections.
  // Re-running on a short cadence makes the question reappear within one
  // interval if a chain-reset clears the in-memory cache.
  async function seedStaging() {
    if (!seedTransaction) return getStatus();
    const now = nowFn();
    const id = "news-daily-" + utcDayId(now);

    // Already present (seeded earlier, or a real memo arrived)? No-op.
    try {
      const { created } = parseExisting(getRawTransactions, appPubkey);
      if (created.has(id)) return getStatus();
    } catch (_) {
      /* fall through and seed */
    }

    // Try to get a real headline; use a fallback only if HN is unreachable.
    let headlineText =
      "Lawmakers push for mandatory AI content labels on social platforms";
    let sourceUrl = "#";
    let sourceName = "Hacker News";
    try {
      const hn = await fetchHeadline();
      headlineText = hn.title;
      sourceUrl = hn.url;
      sourceName = hn.sourceName;
    } catch (e) {
      console.warn(`[daily-news] staging HN fetch failed, using fallback: ${e.message}`);
    }

    const memo = buildCreateMemo(
      id,
      "Should social media platforms be legally required to label AI-generated content?",
      "Yes",
      "No",
      headlineText,
      sourceUrl,
      sourceName,
      now
    );
    const seedTxId = "staging-seed-news-" + id;
    const tx = {
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
      status.lastCreateAt = now;
      status.lastCreateId = id;
      status.lastSendError = null;
      status.lastHeadline = headlineText;
      console.log(`[daily-news] staging-seeded ${id} (${sourceName})`);
    } catch (e) {
      status.lastSendError = `staging seed ${id}: ${e.message}`;
      console.error(`[daily-news] staging seed error (${id}): ${e.message}`);
    }
    return getStatus();
  }

  function safeSeedStaging() {
    return seedStaging().catch((e) => {
      console.error(`[daily-news] staging seed error: ${e.message}`);
      return getStatus();
    });
  }

  // Snapshot of scheduler health + whether today's poll already exists.
  function getStatus() {
    const now = nowFn();
    const todayId = "news-daily-" + utcDayId(now);
    let todayExists = false;
    try {
      const { created } = parseExisting(getRawTransactions, appPubkey);
      todayExists = created.has(todayId);
    } catch (_) {
      /* best-effort */
    }
    return {
      todayPollId: todayId,
      todayExists,
      startedAt: status.startedAt,
      lastTickAt: status.lastTickAt,
      lastCreateAt: status.lastCreateAt,
      lastCreateId: status.lastCreateId,
      lastHeadline: status.lastHeadline,
      lastFetchError: status.lastFetchError,
      lastSendError: status.lastSendError,
      llmEnabled,
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
    // Startup catch-up: try to create today's poll shortly after boot (2 s
    // after daily-btc's 10 s warmup), then align to the next UTC midnight.
    const warmup = setTimeout(() => safeTick(), 12000);
    if (warmup.unref) warmup.unref();
    scheduleNextMidnight();
    safetyTimer = setInterval(() => safeTick(), SAFETY_TICK_MS);
    if (safetyTimer.unref) safetyTimer.unref();
    console.log(
      "[daily-news] scheduler started (UTC-daily + safety tick every " +
        Math.round(SAFETY_TICK_MS / 60000) +
        "m)"
    );

    if (!llmEnabled) {
      console.warn(
        "[daily-news] LLM proxy not configured (USERNODE_LLM_PROXY_TOKEN absent) — daily news polls disabled in production"
      );
    }

    // Staging only: seed the demo question into the cache right away, then
    // keep re-seeding so it survives a chain-reset that clears the cache.
    // seedTransaction is null in production, so this whole branch is a no-op.
    if (seedTransaction) {
      const seedWarmup = setTimeout(() => safeSeedStaging(), 4000);
      if (seedWarmup.unref) seedWarmup.unref();
      stagingSeedTimer = setInterval(() => safeSeedStaging(), STAGING_SEED_INTERVAL_MS);
      if (stagingSeedTimer.unref) stagingSeedTimer.unref();
      console.log(
        "[daily-news] staging seed enabled (re-seed every " +
          Math.round(STAGING_SEED_INTERVAL_MS / 60000) +
          "m)"
      );
    }
  }

  function stop() {
    stopped = true;
    if (midnightTimer) clearTimeout(midnightTimer);
    if (safetyTimer) clearInterval(safetyTimer);
    if (stagingSeedTimer) clearInterval(stagingSeedTimer);
  }

  return {
    start,
    stop,
    tick: safeTick,
    seedStaging: safeSeedStaging,
    getStatus,
    _parseExisting: () => parseExisting(getRawTransactions, appPubkey),
  };
}

module.exports = createDailyNews;
module.exports.utcDayId = utcDayId;
module.exports.nextUtcMidnight = nextUtcMidnight;
