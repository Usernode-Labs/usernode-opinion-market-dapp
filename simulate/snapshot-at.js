#!/usr/bin/env node
/**
 * Simulate what a user's client would display at a specific moment in
 * time by running computeFullState against ONLY the txs that existed
 * before that moment. Reveals stale-credit and stale-pool drift between
 * the client's view and reality.
 *
 * Usage:
 *   node simulate/snapshot-at.js <pubkey> <ISO-timestamp>
 *
 * Example:
 *   node simulate/snapshot-at.js ut1z228zkwhe... 2026-05-19T15:03:00Z
 */
"use strict";
const fs = require("fs");
const OMS = require("../public/opinion-market-state.js");
const APP_PUBKEY = "ut1zkj9p90e0w0hqsnmr70xmzdcvhrj80upajpw67eywszu2g0qknksl3mlms";

async function main() {
  const pubkey = process.argv[2];
  const atIso = process.argv[3];
  const txsPath = process.argv[4] || "/tmp/om_txs.json";
  const configPath = process.argv[5] || "/tmp/config.json";
  if (!pubkey || !atIso) {
    console.error("usage: snapshot-at.js <pubkey> <ISO-timestamp> [txs.json] [config.json]");
    process.exit(2);
  }
  const cutoffMs = Date.parse(atIso);
  if (!Number.isFinite(cutoffMs)) { console.error("bad timestamp"); process.exit(2); }

  const txsResp = JSON.parse(fs.readFileSync(txsPath, "utf8"));
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const allRaw = Array.isArray(txsResp.items) ? txsResp.items : (Array.isArray(txsResp) ? txsResp : []);

  // Filter txs to only those with ts <= cutoffMs (this is what the user's
  // client would have seen at that moment). Use the shared module's
  // normalizer so we extract the same field the rebuild does.
  function txTs(t) {
    const norm = OMS.normalizeTx(t);
    return norm ? norm.ts : 0;
  }
  const beforeRaw = allRaw.filter(t => txTs(t) <= cutoffMs);

  // "Now" snapshot uses ALL txs (for comparison).
  const opts = {
    appPubkey: APP_PUBKEY,
    adminPubkey: cfg.admin_pubkey,
    genesisAccounts: cfg.genesis_accounts,
    globalUsernames: {},
    now: cutoffMs,
  };

  const snapState = await OMS.computeFullState(Object.assign({}, opts, {
    rawTxs: beforeRaw, decryptedTxs: beforeRaw,
  }));
  const nowState = await OMS.computeFullState(Object.assign({}, opts, {
    rawTxs: allRaw, decryptedTxs: allRaw, now: Date.now(),
  }));

  const snapBal = OMS.userBalance(snapState, pubkey);
  const nowBal = OMS.userBalance(nowState, pubkey);
  const snapShares = OMS.userShareValue(snapState, pubkey);
  const nowShares = OMS.userShareValue(nowState, pubkey);
  const snapFlow = snapState.CREDIT_FLOWS.get(pubkey);
  const nowFlow = nowState.CREDIT_FLOWS.get(pubkey);

  console.log(`Snapshot at ${atIso} (${beforeRaw.length} of ${allRaw.length} txs visible)`);
  console.log();
  console.log("                              at snapshot         now (full feed)");
  console.log("Joined:                     ", snapState.JOINED.has(pubkey).toString().padStart(8), "                ", nowState.JOINED.has(pubkey).toString());
  console.log("Liquid balance:             ", snapBal.toFixed(2).padStart(10), "          ", nowBal.toFixed(2).padStart(10));
  console.log("Share value (mark-to-mkt):  ", snapShares.toFixed(2).padStart(10), "          ", nowShares.toFixed(2).padStart(10));
  console.log("Total wealth:               ", (snapBal + snapShares).toFixed(2).padStart(10), "          ", (nowBal + nowShares).toFixed(2).padStart(10));

  console.log();
  console.log("Credit flow components:");
  console.log("  antes           ", (snapFlow?.antes ?? 0).toFixed(2).padStart(10), "          ", (nowFlow?.antes ?? 0).toFixed(2).padStart(10));
  console.log("  gross bets      ", (snapFlow?.grossBets ?? 0).toFixed(2).padStart(10), "          ", (nowFlow?.grossBets ?? 0).toFixed(2).padStart(10));
  console.log("  net sells       ", (snapFlow?.netSells ?? 0).toFixed(2).padStart(10), "          ", (nowFlow?.netSells ?? 0).toFixed(2).padStart(10));
  console.log("  payouts         ", (snapFlow?.payouts ?? 0).toFixed(2).padStart(10), "          ", (nowFlow?.payouts ?? 0).toFixed(2).padStart(10));
  console.log("  dividends       ", (snapFlow?.dividends ?? 0).toFixed(2).padStart(10), "          ", (nowFlow?.dividends ?? 0).toFixed(2).padStart(10));
  console.log("  creator rewards ", (snapFlow?.creatorRewards ?? 0).toFixed(2).padStart(10), "          ", (nowFlow?.creatorRewards ?? 0).toFixed(2).padStart(10));

  // Active surveys at snapshot time
  console.log();
  console.log("Active markets at snapshot time:");
  for (const sv of snapState.SURVEYS) {
    if (sv.archived) continue;
    const mkt = snapState.MARKETS.get(sv.id);
    if (!mkt) continue;
    const liquidity = OMS.cpmmTotalLiquidity(mkt);
    const maxBet = Math.floor(liquidity * OMS.MAX_BET_POOL_RATIO);
    console.log(`  ${sv.id.slice(0, 50).padEnd(52)} pool=${liquidity.toFixed(0).padStart(5)} maxBet=${maxBet.toString().padStart(4)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
