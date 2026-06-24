/**
 * AI pros/cons insights for Opinion Market question/market detail.
 *
 * Serves `GET /__om/ai-summary/:surveyId`. For a given survey it builds a
 * neutral, balanced pros/cons list per side by calling the platform LLM
 * proxy (USERNODE_LLM_PROXY_URL / USERNODE_LLM_PROXY_TOKEN) — the same relay
 * daily-news.js uses. No Anthropic key is stored per-app; the proxy bills the
 * signed-in user under the dapp.json `llm` consent grant.
 *
 * Gating & degradation:
 *   - Production containers receive the proxy env vars; staging and
 *     standalone deploys do NOT (unreviewed PR code must not spend user
 *     budgets). When the token is absent the endpoint returns
 *     `{ enabled: false }` with 200 and the client hides the AI card.
 *
 * Cost control:
 *   - Results are cached in-memory per surveyId with a TTL (default 6h), so
 *     reopening a question is free. Parallel deploys sharing APP_PUBKEY each
 *     keep their own cache — a small, bounded redundant spend, mirroring the
 *     publish_pubkeys/reveal_key trade-off documented in CLAUDE.md.
 *
 * The endpoint is public + read-only (consistent with OM's auth model). The
 * client sends ONLY a survey id; the server derives all LLM context from its
 * own raw-tx cache — client-supplied prompt text is never trusted.
 */

"use strict";

const http = require("http");
const https = require("https");

const OMS = require("./public/opinion-market-state.js");
const CPMM = require("./public/opinion-market-core.js");

const APP_ID = "opinion-market";
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const LLM_TIMEOUT_MS = 30000;
const MODEL = "claude-haiku-4-5-20251001";
// Many-option markets: only summarize the leading few sides to bound tokens.
const MAX_SIDES = 4;

// Generic JSON HTTP POST — mirrors daily-news.js's httpRequest, scoped to the
// proxy call. Injectable in tests via opts.httpPost.
function defaultHttpPost(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const urlParsed = new URL(url);
    const isHttps = urlParsed.protocol === "https:";
    const mod = isHttps ? https : http;
    const bodyBuf = Buffer.from(JSON.stringify(body));
    const opts = {
      hostname: urlParsed.hostname,
      port: urlParsed.port || (isHttps ? 443 : 80),
      path: urlParsed.pathname + (urlParsed.search || ""),
      method: "POST",
      headers: Object.assign(
        {
          accept: "application/json",
          "content-type": "application/json",
          "content-length": bodyBuf.length,
        },
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
    req.write(bodyBuf);
    req.end();
  });
}

// Strip ```json fences a model may wrap its output in, then JSON.parse.
function parseModelJson(text) {
  const raw = String(text || "").trim();
  const jsonStr = raw.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "").trim();
  return JSON.parse(jsonStr);
}

function createAiSummary(opts) {
  opts = opts || {};
  const appPubkey = opts.appPubkey;
  const getRawTransactions = opts.getRawTransactions || (() => []);
  const genesisAccounts = opts.genesisAccounts || [];
  const ttlMs = typeof opts.ttlMs === "number" ? opts.ttlMs : DEFAULT_TTL_MS;
  const nowFn = opts.now || Date.now;
  const httpPost = opts.httpPost || defaultHttpPost;

  // Proxy creds: explicit opts win (tests), else platform-injected env.
  function proxyUrl() {
    return opts.llmProxyUrl != null ? opts.llmProxyUrl : (process.env.USERNODE_LLM_PROXY_URL || "");
  }
  function proxyToken() {
    return opts.llmProxyToken != null ? opts.llmProxyToken : (process.env.USERNODE_LLM_PROXY_TOKEN || "");
  }
  function isEnabled() {
    return !!(proxyUrl() && proxyToken());
  }

  // surveyId -> { expires, data }
  const cache = new Map();
  // surveyId -> Promise (in-flight dedup so concurrent opens make one call)
  const inflight = new Map();

  // Build the LLM context for a survey from the raw-tx cache: question,
  // options, current implied odds, and (news polls) the source headline.
  // Returns null if the survey isn't found.
  async function buildContext(surveyId) {
    const rawTxs = getRawTransactions() || [];
    const state = await OMS.computeFullState({
      rawTxs: rawTxs,
      // Pass rawTxs as decryptedTxs to skip vote decryption — we only need
      // market odds (from plaintext place_bet txs), never vote choices.
      decryptedTxs: rawTxs,
      appPubkey: appPubkey,
      adminPubkey: opts.adminPubkey || null,
      genesisAccounts: genesisAccounts,
      globalUsernames: {},
      now: nowFn(),
    });
    const survey = state.SURVEYS_BY_ID.get(String(surveyId));
    if (!survey) return null;

    const mkt = state.MARKETS.get(survey.id) || null;
    const sides = survey.options.map((o) => {
      const pool = mkt && mkt.pools ? mkt.pools[o.key] : null;
      const prob = pool ? CPMM.cpmmProb(pool) : 0;
      return { key: o.key, label: o.label, prob: prob };
    });
    // Bound to the leading MAX_SIDES options for many-option markets.
    let chosen = sides;
    if (sides.length > MAX_SIDES) {
      chosen = sides.slice().sort((a, b) => b.prob - a.prob).slice(0, MAX_SIDES);
      console.log(`[ai-summary] ${survey.id}: capped to top ${MAX_SIDES} of ${sides.length} options`);
    }
    return {
      id: survey.id,
      title: survey.title || "",
      question: survey.question || "",
      kind: survey.kind || null,
      headline: survey.headline || null,
      sourceName: survey.sourceName || null,
      sides: chosen,
    };
  }

  function buildPrompt(ctx) {
    const oddsLines = ctx.sides
      .map((s) => `- ${s.label} (key "${s.key}"): market-implied ${(s.prob * 100).toFixed(0)}%`)
      .join("\n");
    let extra = "";
    if (ctx.kind === "news_poll" && ctx.headline) {
      extra = `\nSource headline: ${ctx.headline}` + (ctx.sourceName ? ` (${ctx.sourceName})` : "");
    }
    const sideKeys = ctx.sides.map((s) => `"${s.key}"`).join(", ");
    const system =
      "You are a neutral analyst for a prediction market. For the given " +
      "question, write a balanced, concise pros/cons list for EACH side — " +
      "reasons a rational person might favor that outcome (pros) and reasons " +
      "for doubt (cons). Rules:\n" +
      "- Be even-handed; do not advocate or predict a winner.\n" +
      "- 2-3 short bullet points per list, each under 120 characters.\n" +
      "- Ground bullets in the question's substance, not betting mechanics.\n" +
      "- No financial advice, no 'you should'.\n" +
      `- Respond ONLY with valid JSON: {"sides":[{"key":<one of ${sideKeys}>,"pros":["..."],"cons":["..."]}]}`;
    const user =
      `Question: ${ctx.question || ctx.title}\n` +
      `Sides and current odds:\n${oddsLines}${extra}\n\n` +
      "Generate the pros/cons JSON.";
    return { system, user };
  }

  async function generate(ctx) {
    const { system, user } = buildPrompt(ctx);
    const resp = await httpPost(
      `${proxyUrl()}/v1/messages`,
      {
        "anthropic-version": "2023-06-01",
        "x-usernode-app-token": proxyToken(),
      },
      {
        model: MODEL,
        max_tokens: 700,
        system: system,
        messages: [{ role: "user", content: user }],
      },
      LLM_TIMEOUT_MS
    );
    const content = resp && Array.isArray(resp.content) ? resp.content : [];
    const textBlock = content.find((b) => b.type === "text");
    if (!textBlock) throw new Error("no text block in LLM response");
    const parsed = parseModelJson(textBlock.text);
    if (!parsed || !Array.isArray(parsed.sides)) throw new Error("LLM returned no sides array");

    // Keep only sides whose key is one we asked about; sanitize bullets.
    const validKeys = new Set(ctx.sides.map((s) => s.key));
    const labelByKey = {};
    ctx.sides.forEach((s) => { labelByKey[s.key] = s.label; });
    const cleanList = (arr) =>
      (Array.isArray(arr) ? arr : [])
        .filter((x) => typeof x === "string" && x.trim())
        .map((x) => x.trim().slice(0, 200))
        .slice(0, 3);
    const sides = parsed.sides
      .filter((s) => s && validKeys.has(String(s.key)))
      .map((s) => ({
        key: String(s.key),
        label: labelByKey[String(s.key)],
        pros: cleanList(s.pros),
        cons: cleanList(s.cons),
      }))
      .filter((s) => s.pros.length || s.cons.length);

    return { enabled: true, surveyId: ctx.id, model: MODEL, generatedAt: nowFn(), sides: sides };
  }

  // Returns the cached/fresh summary object for a survey. Throws on failure.
  async function getSummary(surveyId) {
    surveyId = String(surveyId);
    if (!isEnabled()) return { enabled: false };

    const hit = cache.get(surveyId);
    if (hit && hit.expires > nowFn()) return hit.data;

    if (inflight.has(surveyId)) return inflight.get(surveyId);

    const p = (async () => {
      const ctx = await buildContext(surveyId);
      if (!ctx) return { enabled: true, surveyId: surveyId, sides: [], notFound: true };
      const data = await generate(ctx);
      cache.set(surveyId, { expires: nowFn() + ttlMs, data: data });
      return data;
    })();
    inflight.set(surveyId, p);
    try {
      return await p;
    } finally {
      inflight.delete(surveyId);
    }
  }

  // Express-style request handler. Returns true if it consumed the request.
  function handleRequest(req, res, pathname) {
    const m = /^\/__om\/ai-summary\/(.+)$/.exec(pathname);
    if (!m) return false;
    const surveyId = decodeURIComponent(m[1]);
    res.set("Cache-Control", "no-store");
    res.set("Access-Control-Allow-Origin", "*");
    if (!isEnabled()) {
      res.json({ enabled: false });
      return true;
    }
    getSummary(surveyId)
      .then((data) => res.json(data))
      .catch((e) => {
        console.warn(`[ai-summary] ${surveyId} failed: ${e.message}`);
        // Degrade gracefully — the client hides the card on a non-ok shape.
        res.status(502).json({ enabled: true, error: "generation_failed" });
      });
    return true;
  }

  function getStatus() {
    return { enabled: isEnabled(), model: MODEL, cached: cache.size, ttlMs: ttlMs };
  }

  // Test seam: clear the in-memory cache between assertions.
  function _resetCache() {
    cache.clear();
    inflight.clear();
  }

  return { getSummary, handleRequest, getStatus, isEnabled, _resetCache, buildContext, buildPrompt };
}

module.exports = createAiSummary;
module.exports.MODEL = MODEL;
