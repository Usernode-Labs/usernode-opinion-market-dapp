#!/usr/bin/env node
/**
 * Opinion Market replay CLI.
 *
 * Pulls the live Opinion Market tx feed from a server (default:
 * https://dapps.usernodelabs.org), runs the shared `computeFullState`
 * pipeline against it, and prints per-user diagnostics.
 *
 * This is the same pipeline the client UI and the server-side
 * `/leaderboard` endpoint run. So a discrepancy between what the live
 * UI shows and what this CLI prints is a UI bug, not a replay bug.
 *
 * Usage:
 *   node simulate/replay.js summary
 *   node simulate/replay.js user <pubkey-or-username>
 *   node simulate/replay.js rejects <pubkey-or-username>
 *   node simulate/replay.js diff-config   # compare default vs ungated vs no-admin
 *
 * Flags:
 *   --server <url>     base URL (default https://dapps.usernodelabs.org)
 *   --txs <path>       use a local txs.json instead of hitting the server
 *   --config <path>    use a local /__config/opinion-market JSON
 *   --usernames <path> use a local /__usernames/state JSON
 *   --no-admin         skip the admin-pubkey gate (debug)
 *   --no-genesis       skip the genesis-account gate (debug)
 *   --json             machine-readable output
 *
 * Examples:
 *   node simulate/replay.js user scraido
 *   node simulate/replay.js user ut1z228zkwhe...
 *   node simulate/replay.js rejects scraido --json
 */

"use strict";

const path = require("path");
const https = require("https");
const http = require("http");
const fs = require("fs");
const OMS = require("../public/opinion-market-state.js");

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-admin") args.flags.noAdmin = true;
    else if (a === "--no-genesis") args.flags.noGenesis = true;
    else if (a === "--json") args.flags.json = true;
    else if (a === "--server" || a === "--txs" || a === "--config" || a === "--usernames") args.flags[a.slice(2)] = argv[++i];
    else args._.push(a);
  }
  return args;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib.get(url, { headers: { "User-Agent": "om-replay/1.0" } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} on ${url}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function loadInputs(server, flags) {
  // Config (admin + genesis) and txs + usernames. The /__usernames/state
  // endpoint and /__config/opinion-market mirror what the production
  // client fetches at startup, so this is a faithful replay.
  const loadOrFetch = (localPath, url, fallback) => {
    if (localPath) return Promise.resolve(JSON.parse(fs.readFileSync(localPath, "utf8")));
    if (!url) return Promise.resolve(fallback);
    return fetchJson(url).catch(() => fallback);
  };
  const [config, usernames, txsResp] = await Promise.all([
    loadOrFetch(flags.config, server + "/__config/opinion-market", { admin_pubkey: null, genesis_accounts: [] }),
    loadOrFetch(flags.usernames, server + "/__usernames/state", { usernames: {} }),
    loadOrFetch(flags.txs, server + "/opinion-market/api/transactions?limit=10000", { items: [] }),
  ]);
  const rawTxs = Array.isArray(txsResp.items) ? txsResp.items
    : Array.isArray(txsResp) ? txsResp
    : (txsResp.transactions || []);
  // Server stores usernames as a map { pubkey: { name, ts } } in some
  // shapes; normalize to { pubkey: name }.
  const globalUsernames = {};
  const us = usernames.usernames || usernames || {};
  for (const k of Object.keys(us)) {
    const v = us[k];
    if (typeof v === "string") globalUsernames[k] = v;
    else if (v && typeof v === "object" && v.name) globalUsernames[k] = v.name;
  }
  return { config, globalUsernames, rawTxs };
}

async function runState({ rawTxs, config, globalUsernames, flags }) {
  return OMS.computeFullState({
    rawTxs,
    appPubkey: process.env.APP_PUBKEY
      || "ut1zkj9p90e0w0hqsnmr70xmzdcvhrj80upajpw67eywszu2g0qknksl3mlms",
    adminPubkey: flags.noAdmin ? null : (config.admin_pubkey || null),
    genesisAccounts: flags.noGenesis ? [] : (config.genesis_accounts || []),
    globalUsernames,
    now: Date.now(),
  });
}

function resolvePubkey(state, query) {
  if (query.startsWith("ut1")) return query;
  // Treat as a username lookup. The shared module's GLOBAL_USERNAMES is
  // pubkey→name; we invert it. Be loose about suffix-stripping so
  // `scraido` matches `scraido_8es6uft0u` etc.
  for (const [pk, name] of state.GLOBAL_USERNAMES) {
    if (name === query) return pk;
    if (name.replace(/_[A-Za-z0-9]{6}$/, "") === query) return pk;
  }
  return null;
}

function fmtCredits(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function cmdSummary({ state }) {
  console.log("Surveys:        ", state.SURVEYS.length);
  console.log("  archived:     ", state.SURVEYS.filter(s => s.archived).length);
  console.log("Joined users:   ", state.JOINED.size);
  console.log("With credit flow:", state.CREDIT_FLOWS.size);
  console.log("Markets:        ", state.MARKETS.size);
  console.log("First joiner:   ", state.firstJoiner || "(none)");
  let totalBets = 0, totalSells = 0, totalAntes = 0, totalPayouts = 0;
  for (const f of state.CREDIT_FLOWS.values()) {
    totalBets += f.grossBets;
    totalSells += f.netSells;
    totalAntes += f.antes;
    totalPayouts += f.payouts;
  }
  console.log("Total gross bets:", fmtCredits(totalBets), "credits");
  console.log("Total net sells: ", fmtCredits(totalSells), "credits");
  console.log("Total antes:     ", fmtCredits(totalAntes), "credits");
  console.log("Total payouts:   ", fmtCredits(totalPayouts), "credits");
}

function cmdUser({ state, rawTxs, args, appPubkey }) {
  const query = args._[1];
  if (!query) { console.error("usage: replay user <pubkey-or-username>"); process.exit(2); }
  const pubkey = resolvePubkey(state, query);
  if (!pubkey) { console.error(`No user matches '${query}'`); process.exit(3); }

  const name = state.GLOBAL_USERNAMES.get(pubkey) || OMS.deriveDefaultUsername(pubkey);
  const joined = state.JOINED.has(pubkey);
  const flow = state.CREDIT_FLOWS.get(pubkey);
  const balance = OMS.userBalance(state, pubkey);
  const shareValue = OMS.userShareValue(state, pubkey);

  console.log(`User:     ${name}`);
  console.log(`Pubkey:   ${pubkey}`);
  console.log(`Joined:   ${joined}`);
  console.log(`Balance:  ${fmtCredits(balance)} liquid + ${fmtCredits(shareValue)} share value = ${fmtCredits(balance + shareValue)} total`);
  if (flow) {
    console.log("Credit flow:");
    console.log(`  antes:           ${fmtCredits(flow.antes)}`);
    console.log(`  gross bets:      ${fmtCredits(flow.grossBets)}`);
    console.log(`  net sells:       ${fmtCredits(flow.netSells)}`);
    console.log(`  payouts:         ${fmtCredits(flow.payouts)}`);
    console.log(`  dividends:       ${fmtCredits(flow.dividends)}`);
    console.log(`  creator rewards: ${fmtCredits(flow.creatorRewards)}`);
  }

  // Counts of accepted vs rejected place_bet txs from on-chain.
  const parseAppTx = OMS.makeParseAppTx(appPubkey);
  let totalBets = 0, totalSells = 0, totalVotes = 0, totalJoins = 0;
  for (const raw of rawTxs) {
    const p = parseAppTx(raw);
    if (!p || p.tx.from !== pubkey) continue;
    if (p.memo.type === "place_bet") totalBets++;
    else if (p.memo.type === "sell_shares") totalSells++;
    else if (p.memo.type === "vote") totalVotes++;
    else if (p.memo.type === "join") totalJoins++;
  }
  console.log("On-chain tx counts:");
  console.log(`  joins:        ${totalJoins}`);
  console.log(`  place_bet:    ${totalBets}`);
  console.log(`  sell_shares:  ${totalSells}`);
  console.log(`  vote:         ${totalVotes}`);

  // Diff: how many of those bets were actually accepted by Phase 6?
  // Phase 6 records each accepted bet in mkt.grossBetsByUser; we count
  // them across all markets the user touched.
  let acceptedBets = 0;
  for (const mkt of state.MARKETS.values()) {
    if (mkt.grossBetsByUser && mkt.grossBetsByUser[pubkey]) acceptedBets++;
  }
  console.log(`Markets with accepted bets from this user: ${acceptedBets}`);

  const rejected = OMS.findRejectedSends(state, { pubkey, appPubkey, rawTxs });
  console.log(`Rejected place_bet/sell_shares txs: ${rejected.length}`);
  if (rejected.length > 0) {
    console.log("\nTop reasons:");
    const counts = {};
    for (const r of rejected) counts[r.reason] = (counts[r.reason] || 0) + 1;
    for (const [reason, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${reason}: ${n}`);
    }
    console.log("\nTo see full list: replay rejects " + query);
  }
}

function cmdRejects({ state, rawTxs, args, appPubkey, flags }) {
  const query = args._[1];
  if (!query) { console.error("usage: replay rejects <pubkey-or-username>"); process.exit(2); }
  const pubkey = resolvePubkey(state, query);
  if (!pubkey) { console.error(`No user matches '${query}'`); process.exit(3); }
  const rejected = OMS.findRejectedSends(state, { pubkey, appPubkey, rawTxs });
  if (flags.json) {
    console.log(JSON.stringify(rejected, null, 2));
    return;
  }
  for (const r of rejected) {
    const when = new Date(r.ts).toISOString();
    const cred = r.credits != null ? `${r.credits}c` : `${r.shares}sh`;
    console.log(`${when}  ${r.type.padEnd(11)}  ${cred.padStart(8)}  ${r.side.padEnd(3)}  ${r.surveyId}/${r.optionKey || "?"}  REASON=${r.reason}` + (r.balance != null ? `  bal=${fmtCredits(r.balance)}/needed=${r.needed}` : "") + (r.note ? `  (${r.note})` : ""));
  }
}

async function cmdDiffConfig({ rawTxs, config, globalUsernames }) {
  // Helpful for the kind of "wait, are scraido's bets being silently
  // dropped because the admin pubkey is wrong?" question. Shows how
  // CREDIT_FLOWS.size changes under three configurations.
  const variants = [
    { name: "default (config admin + genesis)" },
    { name: "no admin gate              ", noAdmin: true },
    { name: "no genesis gate            ", noGenesis: true },
    { name: "no admin AND no genesis    ", noAdmin: true, noGenesis: true },
  ];
  console.log("Variant".padEnd(36), "Joined", "Bettors", "Total bets");
  for (const v of variants) {
    const state = await runState({ rawTxs, config, globalUsernames, flags: v });
    let bettors = 0, totalBets = 0;
    for (const f of state.CREDIT_FLOWS.values()) {
      if (f.grossBets > 0) { bettors++; totalBets += f.grossBets; }
    }
    console.log(v.name.padEnd(36), String(state.JOINED.size).padStart(6), String(bettors).padStart(7), fmtCredits(totalBets).padStart(11));
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const cmd = args._[0] || "summary";
  const server = args.flags.server || "https://dapps.usernodelabs.org";

  let appPubkey = process.env.APP_PUBKEY
    || "ut1zkj9p90e0w0hqsnmr70xmzdcvhrj80upajpw67eywszu2g0qknksl3mlms";

  const { config, globalUsernames, rawTxs } = await loadInputs(server, args.flags);
  const state = await runState({ rawTxs, config, globalUsernames, flags: args.flags });

  switch (cmd) {
    case "summary":      cmdSummary({ state }); break;
    case "user":         cmdUser({ state, rawTxs, args, appPubkey }); break;
    case "rejects":      cmdRejects({ state, rawTxs, args, appPubkey, flags: args.flags }); break;
    case "diff-config":  await cmdDiffConfig({ rawTxs, config, globalUsernames }); break;
    default:
      console.error("Unknown command: " + cmd);
      console.error("Try: summary | user <name> | rejects <name> | diff-config");
      process.exit(2);
  }
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
