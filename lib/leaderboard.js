/**
 * Leaderboard — thin wrapper around the shared `opinion-market-state.js`
 * pipeline used by both the client UI and this server-side endpoint.
 *
 * This file used to contain a server-side reimplementation of the client's
 * `rebuildState` (Phases 1-8). That duplication was an active source of
 * bugs — the comment at the top of this file warned that "if client logic
 * changes meaningfully, mirror the change here," and in practice the two
 * silently drifted (e.g. NO-share settlement was missing on the server
 * side). After the maragung diagnostic (May 2026) we extracted both into
 * `public/opinion-market-state.js` so the client and server now run the
 * exact same code on the exact same input.
 *
 * If you want to add a new field to the leaderboard payload, do it here.
 * If you want to change how state is rebuilt, do it in
 * `public/opinion-market-state.js`.
 */

const OMS = require("../public/opinion-market-state.js");

async function buildLeaderboard(rawTxs, opts) {
  const state = await OMS.computeFullState({
    rawTxs: rawTxs,
    appPubkey: opts.appPubkey,
    adminPubkey: opts.adminPubkey || null,
    genesisAccounts: opts.genesisAccounts,
    globalUsernames: opts.globalUsernames || {},
    now: typeof opts.now === "number" ? opts.now : Date.now(),
  });

  const { GLOBAL_USERNAMES, JOINED, CREDIT_FLOWS, earningsMap } = state;

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
    const e = earningsMap.get(pubkey) || { totalEarnings: 0, marketsBetOn: 0, marketsVotedOn: 0, marketsWon: 0 };
    const winRate = e.marketsBetOn > 0 ? e.marketsWon / e.marketsBetOn : 0;
    const flow = CREDIT_FLOWS.get(pubkey) || null;
    users.push({
      pubkey,
      username: GLOBAL_USERNAMES.get(pubkey) || OMS.deriveDefaultUsername(pubkey),
      joined: JOINED.has(pubkey),
      credits: JOINED.has(pubkey) ? OMS.userBalance(state, pubkey) : 0,
      total_earnings: e.totalEarnings,
      markets_bet_on: e.marketsBetOn,
      markets_voted_on: e.marketsVotedOn,
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
    if (b.credits !== a.credits) return b.credits - a.credits;
    if (b.total_earnings !== a.total_earnings) return b.total_earnings - a.total_earnings;
    return a.username.localeCompare(b.username);
  });

  return { users, count: users.length };
}

module.exports = {
  buildLeaderboard,
  // Re-exports so existing consumers (tests, future callers) can grab the
  // shared module's constants without a second require statement.
  computeFullState: OMS.computeFullState,
  userBalance: OMS.userBalance,
  INITIAL_CREDITS: OMS.INITIAL_CREDITS,
  MARKET_ANTE: OMS.MARKET_ANTE,
  PLATFORM_LIQUIDITY: OMS.PLATFORM_LIQUIDITY,
  FEE_RATE: OMS.FEE_RATE,
  LIQUIDITY_FEE_RATE: OMS.LIQUIDITY_FEE_RATE,
  CREATOR_REWARD_RATE: OMS.CREATOR_REWARD_RATE,
  CREATOR_REWARD_CAP: OMS.CREATOR_REWARD_CAP,
};
