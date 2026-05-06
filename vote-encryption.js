/**
 * Vote Encryption — server-side key management for Opinion Market.
 *
 * Derives P-256 ECDH key pairs per (survey, interval) from a master seed.
 * Watches for new surveys on-chain, publishes public keys immediately, and
 * publishes private keys when reveal checkpoints pass. Keys are published
 * as on-chain transactions so clients read them from the same tx stream.
 *
 * Also serves a fallback HTTP endpoint for public keys (GET /__om/pubkeys/:id)
 * so clients can encrypt before the on-chain publish_pubkeys tx lands.
 */

const nodeCrypto = require("crypto");

const APP_ID = "opinion-market";
const MAX_KEYS_PER_MEMO = 10;
const P256_ORDER = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");

function toBase64Url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function deriveScalar(seed, label) {
  let scalar = nodeCrypto.createHmac("sha256", seed).update(label).digest();
  let val = BigInt("0x" + scalar.toString("hex"));
  while (val === 0n || val >= P256_ORDER) {
    scalar = nodeCrypto.createHash("sha256").update(scalar).digest();
    val = BigInt("0x" + scalar.toString("hex"));
  }
  return scalar;
}

function deriveKeyPair(seed, surveyId, intervalIndex) {
  const scalar = deriveScalar(seed, `${surveyId}:${intervalIndex}`);
  const ecdh = nodeCrypto.createECDH("prime256v1");
  ecdh.setPrivateKey(scalar);
  const publicKey = ecdh.getPublicKey();
  return { privateKey: scalar, publicKey };
}

function pubkeyToBase64(publicKey) {
  return publicKey.toString("base64");
}

function privateKeyToJwk(privateKey, publicKey) {
  const x = publicKey.slice(1, 33);
  const y = publicKey.slice(33, 65);
  return {
    kty: "EC",
    crv: "P-256",
    x: toBase64Url(x),
    y: toBase64Url(y),
    d: toBase64Url(privateKey),
  };
}

function getRevealCheckpoints(survey) {
  if (!survey.revealIntervalMs) return [survey.expiresAtMs];
  const cps = [];
  let t = survey.createdAtMs + survey.revealIntervalMs;
  while (t <= survey.expiresAtMs) { cps.push(t); t += survey.revealIntervalMs; }
  if (cps.length === 0 || cps[cps.length - 1] !== survey.expiresAtMs) cps.push(survey.expiresAtMs);
  return cps;
}

function getIntervalCount(survey) {
  return getRevealCheckpoints(survey).length;
}

function createVoteEncryption(opts) {
  const seed = Buffer.from(opts.seed || "dev-seed-do-not-use-in-production", "hex").length === 32
    ? Buffer.from(opts.seed, "hex")
    : nodeCrypto.createHash("sha256").update(opts.seed || "dev-seed-do-not-use-in-production").digest();
  const appPubkey = opts.appPubkey;
  const senderPubkey = opts.senderPubkey || appPubkey;
  const senderSecretKey = opts.senderSecretKey || "";
  const nodeRpcUrl = opts.nodeRpcUrl || "http://usernode-node:3000";
  const localDev = !!opts.localDev;
  const mockTransactions = opts.mockTransactions || null;

  // surveyId -> { createdAtMs, revealIntervalMs, expiresAtMs, pubkeysPublished: Set<batch>, revealedIntervals: Set<ki> }
  const surveys = new Map();
  const seenTxIds = new Set();
  let signerConfigured = false;

  function registerSurvey(surveyId, config) {
    if (surveys.has(surveyId)) return surveys.get(surveyId);
    const entry = {
      createdAtMs: config.createdAtMs,
      revealIntervalMs: config.revealIntervalMs || null,
      expiresAtMs: config.expiresAtMs,
      pubkeysPublished: new Set(),
      revealedIntervals: new Set(),
    };
    surveys.set(surveyId, entry);
    console.log(`[vote-enc] registered survey ${surveyId} (${getIntervalCount(entry)} intervals)`);
    return entry;
  }

  function processTransaction(rawTx) {
    const id = rawTx.tx_id || rawTx.id || rawTx.txid || rawTx.hash;
    if (!id || seenTxIds.has(id)) return;
    seenTxIds.add(id);

    const to = rawTx.destination_pubkey || rawTx.to || rawTx.destination;
    if (to !== appPubkey) return;

    let memo;
    try {
      memo = typeof rawTx.memo === "string" ? JSON.parse(rawTx.memo) : rawTx.memo;
    } catch (_) { return; }
    if (!memo || memo.app !== APP_ID) return;

    if (memo.type === "create_survey" && memo.survey) {
      const s = memo.survey;
      const ts = rawTx.timestamp_ms || (rawTx.created_at ? Date.parse(rawTx.created_at) : null) || Date.now();
      const activeDuration = s.active_duration_ms || s.activeDurationMs;
      if (!s.id || !activeDuration) return;
      registerSurvey(s.id, {
        createdAtMs: ts,
        revealIntervalMs: s.reveal_interval_ms ?? s.revealIntervalMs ?? null,
        expiresAtMs: ts + activeDuration,
      });
    } else if (memo.type === "publish_pubkeys" && memo.survey) {
      const entry = surveys.get(memo.survey);
      if (!entry) return;
      const batch = memo.batch || 0;
      entry.pubkeysPublished.add(batch);
    } else if (memo.type === "reveal_key" && memo.survey != null && memo.ki != null) {
      const entry = surveys.get(memo.survey);
      if (!entry) return;
      entry.revealedIntervals.add(Number(memo.ki));
    }
  }

  // ── RPC / mock transaction sending ──────────────────────────────────────

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
          try { resolve(JSON.parse(text)); }
          catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
        });
      });
      req.on("error", reject);
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  }

  async function configureSigner() {
    if (!senderSecretKey) return false;
    try {
      const resp = await httpJson("POST", `${nodeRpcUrl}/wallet/signer`, { secret_key: senderSecretKey });
      if (resp && resp.ok) { console.log("[vote-enc] signer configured"); return true; }
      console.error("[vote-enc] signer config failed:", resp);
      return false;
    } catch (e) {
      console.error("[vote-enc] signer config error:", e.message);
      return false;
    }
  }

  async function sendKeyTx(memo) {
    const memoStr = JSON.stringify(memo);

    if (localDev && mockTransactions) {
      const tx = {
        id: nodeCrypto.randomUUID(),
        from_pubkey: senderPubkey,
        destination_pubkey: appPubkey,
        amount: 1,
        memo: memoStr,
        created_at: new Date().toISOString(),
      };
      mockTransactions.push(tx);
      processTransaction(tx);
      return true;
    }

    if (!senderSecretKey) {
      console.warn("[vote-enc] no sender secret key configured, cannot publish keys on-chain");
      return false;
    }

    try {
      if (!signerConfigured) {
        signerConfigured = await configureSigner();
        if (!signerConfigured) return false;
      }
      const resp = await httpJson("POST", `${nodeRpcUrl}/wallet/send`, {
        from_pk_hash: senderPubkey,
        amount: 1,
        to_pk_hash: appPubkey,
        fee: 0,
        memo: Buffer.from(memoStr).toString("base64url"),
      });
      if (resp && resp.queued) return true;
      console.error("[vote-enc] send failed:", resp);
      return false;
    } catch (e) {
      console.error("[vote-enc] send error:", e.message);
      return false;
    }
  }

  // ── Key publication logic ───────────────────────────────────────────────

  function buildPubkeysForSurvey(surveyId) {
    const entry = surveys.get(surveyId);
    if (!entry) return {};
    const count = getIntervalCount(entry);
    const keys = {};
    for (let i = 0; i < count; i++) {
      const kp = deriveKeyPair(seed, surveyId, i);
      keys[String(i)] = pubkeyToBase64(kp.publicKey);
    }
    return keys;
  }

  async function publishPubkeys(surveyId) {
    const entry = surveys.get(surveyId);
    if (!entry) return;
    const count = getIntervalCount(entry);
    const batchCount = Math.ceil(count / MAX_KEYS_PER_MEMO);

    for (let batch = 0; batch < batchCount; batch++) {
      if (entry.pubkeysPublished.has(batch)) continue;
      const keys = {};
      const start = batch * MAX_KEYS_PER_MEMO;
      const end = Math.min(start + MAX_KEYS_PER_MEMO, count);
      for (let i = start; i < end; i++) {
        const kp = deriveKeyPair(seed, surveyId, i);
        keys[String(i)] = pubkeyToBase64(kp.publicKey);
      }
      const memo = { app: APP_ID, type: "publish_pubkeys", survey: surveyId, keys };
      if (batchCount > 1) memo.batch = batch;
      const ok = await sendKeyTx(memo);
      if (ok) {
        entry.pubkeysPublished.add(batch);
        console.log(`[vote-enc] published pubkeys for ${surveyId} batch ${batch}`);
      }
    }
  }

  async function publishRevealKey(surveyId, ki) {
    const entry = surveys.get(surveyId);
    if (!entry || entry.revealedIntervals.has(ki)) return;
    const kp = deriveKeyPair(seed, surveyId, ki);
    const jwk = privateKeyToJwk(kp.privateKey, kp.publicKey);
    const memo = { app: APP_ID, type: "reveal_key", survey: surveyId, ki, d: jwk.d };
    const ok = await sendKeyTx(memo);
    if (ok) {
      entry.revealedIntervals.add(ki);
      console.log(`[vote-enc] revealed key for ${surveyId} interval ${ki}`);
    }
  }

  async function checkAndPublishKeys() {
    const now = Date.now();
    for (const [surveyId, entry] of surveys) {
      const totalBatches = Math.ceil(getIntervalCount(entry) / MAX_KEYS_PER_MEMO);
      if (entry.pubkeysPublished.size < totalBatches) {
        await publishPubkeys(surveyId);
      }

      const checkpoints = getRevealCheckpoints(entry);
      for (let i = 0; i < checkpoints.length; i++) {
        if (checkpoints[i] <= now && !entry.revealedIntervals.has(i)) {
          await publishRevealKey(surveyId, i);
        }
      }
    }
  }

  // ── HTTP fallback for pubkeys ───────────────────────────────────────────

  function handleRequest(req, res, pathname) {
    const match = pathname.match(/^\/__om\/pubkeys\/(.+)/);
    if (!match || req.method !== "GET") return false;

    const surveyId = decodeURIComponent(match[1]);
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const createdAtMs = Number(url.searchParams.get("createdAtMs"));
    const revealIntervalMs = url.searchParams.get("revealIntervalMs");
    const expiresAtMs = Number(url.searchParams.get("expiresAtMs"));

    if (createdAtMs && expiresAtMs) {
      registerSurvey(surveyId, {
        createdAtMs,
        revealIntervalMs: revealIntervalMs ? Number(revealIntervalMs) : null,
        expiresAtMs,
      });
    }

    const entry = surveys.get(surveyId);
    if (!entry) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Survey not found. Provide createdAtMs and expiresAtMs query params." }));
      return true;
    }

    const keys = buildPubkeysForSurvey(surveyId);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" });
    res.end(JSON.stringify({ pubkeys: keys }));
    return true;
  }

  // ── Start background loop ───────────────────────────────────────────────

  function start() {
    setInterval(() => {
      checkAndPublishKeys().catch(e => console.error("[vote-enc] check error:", e.message));
    }, 30000);
    // Chain plumbing (live polling, backfill, mock-drain) is owned by the
    // surrounding createAppStateCache wiring in server.js.
  }

  function reset() {
    seenTxIds.clear();
    surveys.clear();
    signerConfigured = false;
    console.log("[vote-enc] state reset (chain restart detected)");
  }

  return {
    processTransaction,
    handleRequest,
    start,
    checkAndPublishKeys,
    buildPubkeysForSurvey,
    reset,
    surveys,
  };
}

module.exports = createVoteEncryption;
