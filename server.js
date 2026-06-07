/**
 * Opinion Market — standalone server for Usernode social-vibecoding.
 *
 * Hosts the Opinion Market dapp: prediction-market-powered surveys with
 * encrypted on-chain voting.
 *   - Users send 1 token to APP_PUBKEY with a JSON memo that encodes the
 *     dapp action (`create_survey` / `vote` / `add_option` / `set_username`).
 *   - Server detects every tx via the chain poller (recipient query), feeds
 *     the raw stream to vote-encryption.js, and publishes per-survey
 *     `publish_pubkeys` (immediate) and `reveal_key` (at each reveal
 *     checkpoint) transactions back on chain.
 *   - Server exposes the raw tx stream at /opinion-market/api/transactions
 *     (clients re-derive market state from it), plus an HTTP fallback for
 *     pubkeys at /__om/pubkeys/:surveyId so clients can encrypt before the
 *     on-chain publish_pubkeys tx lands.
 *
 * Deploy topology — this server is a behavioral DUPLICATE of the canonical
 * combined-examples deploy at https://dapps.usernodelabs.org/opinion-market.
 *   - Same APP_PUBKEY (the OM read-only address).
 *   - Same ADMIN_PUBKEY (the create-surveys admin).
 *   - Same VOTE_ENCRYPT_SEED — both deploys derive identical key pairs from
 *     the seed so votes encrypted against either one are decryptable by
 *     either one. Default unset → falls back to the dev-seed inside
 *     vote-encryption.js, which is what the canonical deploy also uses.
 *   - Vote-encryption uses a separate sender keypair (SENDER_APP_PUBKEY /
 *     SENDER_APP_SECRET_KEY) so the `publish_pubkeys` and `reveal_key`
 *     wallet sends don't touch funds at APP_PUBKEY. Canonical default is
 *     the lastwin pot keypair (which has UTXOs and never receives OM txs).
 *   - Both deploys publish key txs in parallel; on-chain dedup
 *     (seenTxIds + idempotent producer-side checks) makes that safe.
 *
 * Modes:
 *   node server.js              — production mode (real chain)
 *   node server.js --local-dev  — local dev (mock transaction store)
 *
 * Auth model: OM is public. There is no JWT gate on the HTTP surface — any
 * visitor can load the page and read /opinion-market/api/transactions or
 * /__om/pubkeys/:surveyId. Transaction signing happens client-side via the
 * bridge (native Usernode channel inside the Flutter WebView, iframe-relay,
 * or QR fallback). The server never reads or relies on a platform identity.
 *
 * Env vars:
 *   PORT                   — HTTP port (default 3000 — matches platform scaffold)
 *   APP_PUBKEY             — OM dapp's read-only address (recipient of all OM txs)
 *   ADMIN_PUBKEY           — admin pubkey (can create surveys); empty → everyone
 *   SENDER_APP_PUBKEY      — vote-encryption sender pubkey (publishes key txs)
 *   SENDER_APP_SECRET_KEY  — secret half of SENDER_APP_PUBKEY
 *   VOTE_ENCRYPT_SEED      — hex/string seed for per-survey key derivation
 *                            MUST match every server using the same APP_PUBKEY
 *   NODE_RPC_URL           — sidecar URL (default http://usernode-node:3000 inside compose)
 */

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");

const {
  loadEnvFile,
  handleExplorerProxy,
  createMockApi,
  createAppStateCache,
  createUsernamesCache,
  createNodeStatusProbe,
  createDappServerStatus,
  fetchGenesisAccounts,
} = require("./lib/dapp-server");
const createVoteEncryption = require("./vote-encryption");
const createDailyBtc = require("./daily-btc");
const { buildLeaderboard } = require("./lib/leaderboard");

loadEnvFile();

// ── CLI flags ────────────────────────────────────────────────────────────────
const LOCAL_DEV = process.argv.includes("--local-dev");
// Staging preview containers run in production mode (no --local-dev) but may
// not reach external price APIs or have a working on-chain signer (the wallet
// secret is `private` and not propagated into staging). IS_STAGING gates a
// cache-only seed of the Daily BTC question so the preview is never empty.
const IS_STAGING = process.env.USERNODE_ENV === "staging";
const PORT = parseInt(process.env.PORT, 10) || 3000;

// ── OM config ────────────────────────────────────────────────────────────────
// APP_PUBKEY is the canonical OM address — defaults to the existing
// `dapps.usernodelabs.org/opinion-market` pubkey so this standalone deploy
// reads the same on-chain state out of the box.
const APP_PUBKEY =
  process.env.APP_PUBKEY ||
  "ut1zkj9p90e0w0hqsnmr70xmzdcvhrj80upajpw67eywszu2g0qknksl3mlms";
const ADMIN_PUBKEY = process.env.ADMIN_PUBKEY || "";

// Vote-encryption sender. Distinct from APP_PUBKEY because /wallet/send
// requires a UTXO at the sender, and APP_PUBKEY is a recipient-only address.
// Canonical deploy uses the lastwin pot keypair as the sender.
const SENDER_APP_PUBKEY = process.env.SENDER_APP_PUBKEY || "";
const SENDER_APP_SECRET_KEY = process.env.SENDER_APP_SECRET_KEY || "";

// VOTE_ENCRYPT_SEED. If unset, vote-encryption.js falls back to
// "dev-seed-do-not-use-in-production". The canonical deploy ALSO falls back
// to that seed today, so leaving this unset keeps key-derivation identical
// across parallel deploys (required for cross-deploy decrypt). Override
// only if every co-operating server is configured with the same value.
const VOTE_ENCRYPT_SEED = process.env.VOTE_ENCRYPT_SEED || "";

const NODE_RPC_URL = process.env.NODE_RPC_URL || "http://usernode-node:3000";

// Genesis accounts (fetched once on startup; empty in local-dev). Surfaced
// via /__config/opinion-market — the client uses it to label accounts in
// the leaderboard / market views.
let omGenesisAccounts = [];
if (!LOCAL_DEV) {
  fetchGenesisAccounts().then((accounts) => {
    omGenesisAccounts = accounts;
    console.log(`[om] genesis accounts loaded: ${accounts.length}`);
  }).catch((e) => {
    console.warn(`[om] failed to load genesis accounts: ${e.message}`);
  });
}

// ── Express app ──────────────────────────────────────────────────────────────
const app = express();

// One hop (Caddy) in front of us.
app.set("trust proxy", 1);

// Health check — used by Docker healthcheck and platform polling. Includes a
// daily-BTC status block so "no question posted today" is observable without
// log-diving (dailyBtc is constructed below; guard for boot ordering).
app.get("/health", (_req, res) => {
  let dailyBtcStatus = null;
  try { dailyBtcStatus = typeof dailyBtc !== "undefined" && dailyBtc ? dailyBtc.getStatus() : null; }
  catch (_) { /* best-effort */ }
  res.json({ status: "ok", staging: IS_STAGING, dailyBtc: dailyBtcStatus });
});

// ── Mock API (only --local-dev) ──────────────────────────────────────────────
const mockApi = createMockApi({ localDev: LOCAL_DEV });
app.use((req, res, next) => {
  if (mockApi.handleRequest(req, res, req.path)) return;
  next();
});

// ── Vote encryption + OM cache ───────────────────────────────────────────────
// The cache feeds raw txs into vote-encryption.processTransaction; vote
// encryption maintains its own per-survey state and sends `publish_pubkeys`
// + `reveal_key` txs back on-chain via /wallet/send. Cache also exposes
// the raw-tx store at omCache.getRawTransactions(), which we serve at
// /opinion-market/api/transactions for the client to derive market state.
const voteEncryption = createVoteEncryption({
  seed: VOTE_ENCRYPT_SEED,
  appPubkey: APP_PUBKEY,
  senderPubkey: SENDER_APP_PUBKEY,
  senderSecretKey: SENDER_APP_SECRET_KEY,
  nodeRpcUrl: NODE_RPC_URL,
  localDev: LOCAL_DEV,
  mockTransactions: LOCAL_DEV ? mockApi.transactions : null,
});
voteEncryption.start();

const omCache = createAppStateCache({
  name: "om",
  appPubkey: APP_PUBKEY,
  queryFields: ["recipient"],
  processTransaction: voteEncryption.processTransaction,
  // OM owns its own routes (/opinion-market/api/transactions and
  // /__om/pubkeys/*). The cache still serves the auto-mounted
  // /__usernode/cache/<APP_PUBKEY>/* routes used by the bridge's inclusion
  // polling — handleRequest is called below.
  handleRequest: null,
  onChainReset(newId, oldId) {
    console.log(`[om] chain reset ${oldId} -> ${newId}, resetting vote-encryption state`);
    voteEncryption.reset();
  },
  localDev: LOCAL_DEV,
  mockTransactions: LOCAL_DEV ? mockApi.transactions : null,
  nodeRpcUrl: NODE_RPC_URL,
});
omCache.start();

// ── Daily BTC price-prediction scheduler ─────────────────────────────────────
// Reuses vote-encryption's signer path (sendMemo) to post server-authored
// `create_daily_btc` / `resolve_btc` memos on a UTC-daily cadence. Reads the
// cache's raw-tx feed for idempotency so restarts and parallel deploys don't
// double-create. CoinGecko is keyless — no new secret is required.
const dailyBtc = createDailyBtc({
  appPubkey: APP_PUBKEY,
  senderPubkey: SENDER_APP_PUBKEY || APP_PUBKEY,
  getRawTransactions: () => omCache.getRawTransactions(),
  sendMemo: voteEncryption.sendMemo,
  // Staging only: let the scheduler inject today's question straight into the
  // cache's raw-tx feed (the same feed /opinion-market/api/transactions and
  // opinion-market-state.js read) so the preview renders even without price-API
  // egress or an on-chain signer. Null in production → fully on-chain path.
  seedTransaction: IS_STAGING ? ((tx) => omCache.processTransaction(tx)) : null,
});
dailyBtc.start();

// Internal manual trigger: force a daily-BTC tick now (idempotent) and return
// the resulting status. Lets an operator post today's question immediately
// after a deploy instead of waiting for the next boundary. OM is public (see
// CLAUDE.md "Auth model"); this only invokes the same server-authored,
// signer-gated send path the scheduler already uses — it cannot create a
// question without a valid SENDER_APP_SECRET_KEY.
app.post("/__om/daily-btc/tick", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    let out = await dailyBtc.tick();
    // In staging the on-chain create path is a no-op (no signer); also run the
    // cache seed so an operator can force the preview question immediately.
    if (IS_STAGING) out = await dailyBtc.seedStaging();
    res.json({ ok: true, staging: IS_STAGING, status: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.use((req, res, next) => {
  if (omCache.handleRequest(req, res, req.path)) return;
  next();
});

// Vote-encryption HTTP fallback for clients that need pubkeys before the
// on-chain `publish_pubkeys` tx lands. Routes: /__om/pubkeys/:surveyId
app.use((req, res, next) => {
  if (voteEncryption.handleRequest(req, res, req.path)) return;
  next();
});

// Raw-tx feed for the client. Reads straight off the cache's raw store —
// no second array.
app.get("/opinion-market/api/transactions", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("Access-Control-Allow-Origin", "*");
  res.json({ items: omCache.getRawTransactions() });
});

// Non-secret config the client needs at boot (admin pubkey + genesis
// accounts label list).
app.get("/__config/opinion-market", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    admin_pubkey: ADMIN_PUBKEY || null,
    genesis_accounts: omGenesisAccounts,
  });
});

// Public read-only leaderboard JSON. Mirrors the client's Phase 1-8 rebuild
// (lib/leaderboard.js) so external consumers can poll a single endpoint
// instead of replaying the chain themselves. Includes every account that
// has interacted with the dapp — not just users who appear on the Bet P&L
// leaderboard inside the UI.
app.get("/leaderboard", async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const usernamesState = usernamesCache.getStateResponse();
    const result = await buildLeaderboard(omCache.getRawTransactions(), {
      appPubkey: APP_PUBKEY,
      adminPubkey: ADMIN_PUBKEY || null,
      genesisAccounts: omGenesisAccounts,
      globalUsernames: usernamesState.usernames || {},
      now: Date.now(),
    });
    if (req.query.only_credits === "1") {
      res.json({
        generated_at: Date.now(),
        users: result.users.map(({ pubkey, credits }) => ({ pubkey, credits })),
      });
    } else {
      res.json({
        app: "opinion-market",
        app_pubkey: APP_PUBKEY,
        generated_at: Date.now(),
        ...result,
      });
    }
  } catch (e) {
    console.error("[/leaderboard] failed:", e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

// ── OM JS modules served under /opinion-market/ ─────────────────────────────
// The HTML loads these via the /opinion-market/ prefix (matching the canonical
// platform mount), not the bare /public root, so the same `index.html`
// works whether it's hosted standalone or behind a Caddy that adds a path
// prefix. Both files are also `require()`-able from Node (shared with
// `lib/leaderboard.js`).
const PUBLIC_DIR = path.join(__dirname, "public");
const OM_JS_MODULES = {
  "/opinion-market/opinion-market-core.js": path.join(PUBLIC_DIR, "opinion-market-core.js"),
  "/opinion-market/opinion-market-state.js": path.join(PUBLIC_DIR, "opinion-market-state.js"),
};
for (const [route, filePath] of Object.entries(OM_JS_MODULES)) {
  app.get(route, (_req, res) => {
    try {
      const buf = fs.readFileSync(filePath);
      res.set("Content-Type", "application/javascript; charset=utf-8");
      res.set("Cache-Control", "no-cache, must-revalidate");
      res.set("X-App-Version", getBuildVersion());
      res.send(buf);
    } catch (e) {
      res.status(500).type("text/plain").send(`Failed to read ${path.basename(filePath)}: ${e.message}`);
    }
  });
}

// ── Global usernames cache ───────────────────────────────────────────────────
// Same shared wiring as omCache, just for the global usernames address.
// Public on purpose: usernames are global, identical for every viewer.
const usernamesCache = createUsernamesCache({
  localDev: LOCAL_DEV,
  mockTransactions: LOCAL_DEV ? mockApi.transactions : null,
  nodeRpcUrl: NODE_RPC_URL,
});
usernamesCache.start();

app.use((req, res, next) => {
  if (usernamesCache.handleRequest(req, res, req.path)) return;
  next();
});

// ── Sidecar /status probe (powers /status page node card) ────────────────────
const nodeStatusProbe = createNodeStatusProbe({
  nodeRpcUrl: NODE_RPC_URL,
  localDev: LOCAL_DEV,
});
nodeStatusProbe.registerStream("om", () => omCache.isStreamReady());
nodeStatusProbe.registerStream("usernames", () => usernamesCache.isStreamReady());
nodeStatusProbe.start();

app.use((req, res, next) => {
  if (nodeStatusProbe.handleRequest(req, res, req.path)) return;
  next();
});

// ── Explorer proxy ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (handleExplorerProxy(req, res, req.path)) return;
  next();
});

// ── Build version ────────────────────────────────────────────────────────────
function computeBuildVersion() {
  const hash = crypto.createHash("sha1");
  let names;
  try { names = fs.readdirSync(PUBLIC_DIR).sort(); } catch (_) { return "unknown"; }
  for (const file of names) {
    if (file.startsWith(".")) continue;
    try {
      const data = fs.readFileSync(path.join(PUBLIC_DIR, file));
      hash.update(file).update(data);
    } catch (_) {}
  }
  return hash.digest("hex").slice(0, 8);
}

const STARTUP_BUILD_VERSION = computeBuildVersion();
function getBuildVersion() {
  return LOCAL_DEV ? computeBuildVersion() : STARTUP_BUILD_VERSION;
}
console.log(`  Build version: ${STARTUP_BUILD_VERSION}`);

app.get("/__build", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ version: getBuildVersion(), localDev: LOCAL_DEV });
});

// ── Aggregated dapp-server status (HTML viewer + SSE) ───────────────────────
const dappServerStatus = createDappServerStatus({
  name: "om",
  nodeProbe: nodeStatusProbe,
  localDev: LOCAL_DEV,
  port: PORT,
  getBuildVersion,
});
dappServerStatus.registerCache(omCache);
dappServerStatus.registerCache(usernamesCache);

app.use((req, res, next) => {
  if (dappServerStatus.handleRequest(req, res, req.path)) return;
  next();
});

// ── Static assets ────────────────────────────────────────────────────────────
// usernode-bridge.js, usernode-usernames.js, usernode-loading.js,
// opinion-market-core.js, and any future CSS/images. Public infrastructure.
app.use(express.static(PUBLIC_DIR, {
  index: false,
  etag: true,
  lastModified: true,
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
    res.setHeader("X-App-Version", getBuildVersion());
  },
}));

// ── HTML shell ───────────────────────────────────────────────────────────────
let _indexHtmlCache = null;
let _indexHtmlVersion = null;
function renderIndexHtml() {
  const version = getBuildVersion();
  if (LOCAL_DEV || _indexHtmlCache == null || _indexHtmlVersion !== version) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
    } catch (e) {
      return `<!doctype html><pre>Failed to read index.html: ${e.message}</pre>`;
    }
    // index.html is byte-identical to the canonical opinion-market.html and
    // doesn't currently use __BUILD_VERSION__ placeholders. Substitution
    // here is a no-op until the placeholders are added; keeping it future-
    // proof matches lastwin/echo so adding ?v=BUILD_VERSION cache-busters
    // later doesn't require a server-side change.
    _indexHtmlCache = raw.split("__BUILD_VERSION__").join(version);
    _indexHtmlVersion = version;
  }
  return _indexHtmlCache;
}

app.get("*", (_req, res) => {
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("X-App-Version", getBuildVersion());
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(renderIndexHtml());
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\nOpinion Market server running at http://localhost:${PORT}`);
  console.log(`  App pubkey:      ${APP_PUBKEY.slice(0, 24)}…`);
  console.log(`  Admin pubkey:    ${ADMIN_PUBKEY ? ADMIN_PUBKEY.slice(0, 24) + "…" : "(none — anyone can create surveys)"}`);
  console.log(`  Sender pubkey:   ${SENDER_APP_PUBKEY ? SENDER_APP_PUBKEY.slice(0, 24) + "…" : "(none — vote-encryption WILL FAIL to publish keys)"}`);
  console.log(`  Vote seed:       ${VOTE_ENCRYPT_SEED ? "configured" : "default (dev-seed-do-not-use-in-production)"}`);
  console.log(`  Node RPC:        ${NODE_RPC_URL}`);
  console.log(`  Mode:            ${LOCAL_DEV ? "LOCAL DEV (mock API)" : "production (chain pollers running, public access)"}\n`);
});
