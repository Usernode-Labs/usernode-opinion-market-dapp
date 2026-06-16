# Opinion Market — notes for Claude Code

A prediction-market-powered survey app on the Usernode chain. Users create
surveys, cast encrypted votes, and (for monetary surveys) trade outcome
shares. All state lives on-chain as JSON-memo transactions sent to a shared
`APP_PUBKEY` address. The server-side process derives per-survey
encryption key pairs from a master seed, publishes pubkeys immediately so
clients can encrypt, and reveals the matching private keys at each
configured reveal checkpoint so historical votes become auditable.

This app runs as a child app inside Usernode Social Vibecoding. Read the
authoritative platform conventions before making changes:

**Platform conventions (always current):**
https://usernode.evanshapiro.dev/claude.md

If a rule below this line conflicts with the hosted conventions, the hosted
conventions win.

## Architecture

- `server.js` — Express server. Mock API (--local-dev), OM-specific routes
  (`/opinion-market/api/transactions`, `/__om/pubkeys/:surveyId`,
  `/__config/opinion-market`, `/opinion-market/opinion-market-core.js`,
  `/opinion-market/opinion-market-state.js`), explorer proxy, static
  `public/`, recipient chain poller. No auth middleware (OM is public —
  see "Auth model" below).
- `vote-encryption.js` — Server-side key management. The analog of
  `game-logic.js` (lastwin) and `echo-logic.js` (echo): dedups incoming
  tx, registers surveys, derives per-survey ECDH key pairs from
  `VOTE_ENCRYPT_SEED`, publishes `publish_pubkeys` + `reveal_key`
  transactions back on-chain via the sidecar `/wallet/send`, and serves
  `/__om/pubkeys/:surveyId` as an HTTP fallback for clients that need
  pubkeys before the on-chain `publish_pubkeys` tx lands.
- `lib/dapp-server.js` — Vendored helpers (mock API, chain poller,
  explorer proxy, env loader, status probe, status page). Copied from
  `usernode-dapp-starter`; do not edit in-place — re-vendor from upstream
  when fixes land there.
- `lib/tx-match.js` — Vendored helper used by `lib/dapp-server.js` for
  matching transactions against bridge waiters. Same re-vendor rule.
- `lib/leaderboard.js` — Thin wrapper over `public/opinion-market-state.js`
  that shapes its output into the `/leaderboard` JSON payload. Do not put
  replay logic here.
- `public/` — UI (`index.html`) plus the shared, dual-mode (browser +
  Node) modules `opinion-market-core.js` (pure CPMM math) and
  `opinion-market-state.js` (Phases 1-8 state rebuild, vote decryption,
  bet validation). **`opinion-market-state.js` is the single source of
  truth for OM replay semantics** — both `public/index.html` (client UI)
  and `lib/leaderboard.js` (server endpoint) consume it. Editing it
  changes both at once; do not fork the pipeline back into either
  consumer.
  - Phase 6 (market operations) and Phase 7 (survey settlement) are
    **interleaved** into a single chronological event stream: trade
    events and "survey expired" events are merged and sorted by ts so
    that a settlement's payouts land in `CREDIT_FLOWS` BEFORE any later
    bet's balance check. Before this interleaving, bets placed after a
    settled survey would silently fail Phase 6's `bal < credits` check
    (using a pre-settlement balance) while the UI header (which reads
    post-Phase-7 balance) reported the higher number — burning users'
    tx fees with no on-chain feedback (scraido/maragung, May 2026). The
    `BUG-INLINE-SETTLEMENT` test in `simulate/replay.test.js` guards
    this invariant.
  - Every silently-dropped `place_bet` / `sell_shares` tx is recorded
    in `state.rejectedSends` with a precise reason code
    (`INSUFFICIENT_BALANCE`, `OVER_MAX_BET`, `EXPIRED`, etc). The UI
    consumes this via `renderRejectedBanner()` and surfaces a sticky
    banner to the user. `OMS.validatePlaceBet` enforces the same Phase
    6 rules client-side as a preflight, so well-behaved clients never
    burn a tx fee on a bet that would be dropped — `placeBetFlow` in
    `public/index.html` calls it before `sendTransaction`.
  Also includes the shared `usernode-usernames.js` and
  `usernode-loading.js`. The bridge is loaded from
  `https://social-vibecoding.usernodelabs.org/usernode-bridge/v1/bridge.js` —
  canonical source lives in the social-vibecoding repo at
  `public/usernode-bridge/v1/bridge.js`. Never vendor it per-app; bridge
  fixes ship from one SV redeploy, fleet-wide. The loader is still
  shared infrastructure; do not fork it per-app.
- `simulate/` — Node-only diagnostic harness for replaying the live
  chain feed offline (see `simulate/replay.js`). Useful for explaining
  weird per-user states without touching production.

**Canonical source.** This repository is the canonical source for the OM
client (`public/index.html`) and the shared replay module
(`public/opinion-market-state.js`). The platform-side
`opinion-market.html` snapshot is a downstream copy — when you change
files here, the next platform sync picks them up. Do not edit the
downstream copy; do not assume byte-identity with it.

## Running locally

```bash
npm install
npm run dev          # mock mode, http://localhost:3000
npm start            # production mode (requires .env)
```

## Auth model

Opinion Market is **public**. There is no JWT, no platform login required,
no `req.user` consulted anywhere. The HTTP surface is read-only from the
client's perspective (`/opinion-market/api/transactions`,
`/__om/pubkeys/:surveyId`, `/__config/opinion-market`,
`/__usernames/state`, `/status`). Wallet operations are signed two
different ways:

- **Client → OM (create_survey, vote, add_option, set_username)**: signed
  client-side via `usernode-bridge.js`, which has three modes and picks
  one automatically:
  - **Native (top frame in Flutter WebView)** — the Usernode mobile app
    injects a `Usernode` JS channel on every loaded page (see
    `flutter-mobile-app/lib/features/dapps/dapp_webview_screen.dart`,
    `addJavaScriptChannel('Usernode', …)` on the `WebViewController`). The
    bridge detects this with `!!window.Usernode` and routes
    `sendTransaction` / `signMessage` through the channel.
  - **Iframe-relay (OM embedded inside another page that has the native
    channel — e.g. dapp-starter loaded inside the WebView)** — the
    bridge posts a `discover` message to `window.parent`; if the parent
    ACKs, the child flips into relay mode and round-trips its native calls
    through the parent's `Usernode.postMessage`.
  - **QR fallback (desktop browser, no native channel anywhere in the
    frame stack)** — `sendTransaction` shows a QR code for the user to
    scan with the Usernode mobile app, then polls for inclusion.
- **Server → chain (publish_pubkeys, reveal_key)**: signed server-side by
  `SENDER_APP_SECRET_KEY` against the sidecar `/wallet/signer` +
  `/wallet/send` RPC. The secret never leaves the server process and is
  never returned via the API.

## Memo schema

Memos are JSON. OM only acts on these:

- `client → OM (survey)`:        `{"app":"opinion-market","type":"create_survey","survey":{…}}`
  (optional presentational markers: `"category":"crypto"|"commodity"`, and
  for commodities `"commodity":"gold"|"oil"` — grouping/filter + card badge
  only, no effect on CPMM/settlement; see the `CATEGORIES` / `COMMODITIES`
  registries and `surveyCategory()` in `public/opinion-market-state.js`)
- `client → OM (vote)`:          `{"app":"opinion-market","type":"vote","survey":"<id>","ciphertext":"<b64>","interval":<i>}`
- `client → OM (custom option)`: `{"app":"opinion-market","type":"add_option","survey":"<id>","option":{…}}`
- `client → OM (display name)`:  `{"app":"opinion-market","type":"set_username","username":"<name>"}`
  (also: the global usernames address — see `usernode-usernames.js`)
- `client → OM (propose)`:       `{"app":"opinion-market","type":"propose_question","proposal":{"title":"…","question":"…","options":[…],"allow_custom_options":<bool>}}`
- `client → OM (upvote)`:        `{"app":"opinion-market","type":"upvote_proposal","proposal":"<proposalId>"}`
- `server → OM (pubkeys)`:       `{"app":"opinion-market","type":"publish_pubkeys","survey":"<id>","batch":<n>,"pubkeys":[…]}`
- `server → OM (reveal)`:        `{"app":"opinion-market","type":"reveal_key","survey":"<id>","interval":<i>,"jwk":{…}}`
- `server → OM (daily news)`:    `{"app":"opinion-market","type":"create_daily_news","survey":{"id":"news-daily-YYYY-MM-DD","kind":"news_poll","headline":"…","source_url":"…","source_name":"…",…}}`

The server is a no-op consumer for `vote`, `add_option`,
`propose_question`, and `upvote_proposal` memos — it just keeps them in
the raw-tx cache for the client to render. Surveys are registered when
the server sees their `create_survey` tx, which schedules the immediate
`publish_pubkeys` send and the per-checkpoint `reveal_key` sends.

Question proposals (`propose_question` / `upvote_proposal`) need **no**
server work: promotion is derived deterministically in
`public/opinion-market-state.js` Phase 3a. A proposal goes live as a
real survey/market once its upvoter set reaches `ceil(activeUsers/2)`,
where `activeUsers` is the count of distinct accounts with an
ACTIVITY_TYPES tx in the trailing `PROPOSAL_ACTIVE_WINDOW_MS` (72h)
**anchored to the triggering upvote tx's `ts`, never `now`** so client
and server replay always agree. The proposer auto-upvotes their own
proposal; promotion latches (later upvotes don't move `promotedAtMs`);
each user may hold at most `MAX_OPEN_PROPOSALS_PER_USER` (3) open
proposals; proposals expire after `PROPOSAL_EXPIRY_MS` (7 days). Promoted
proposals are merged into Phase 3's survey list (bypassing the admin
gate/cooldown) and seed a market like any other survey.

## Sidecar dependency

In production OM calls `POST /wallet/tracked_owner/add` and
`POST /wallet/signer` against the social-vibecoding `usernode-node`
sidecar at startup, then `POST /wallet/send` whenever a survey reaches a
publish or reveal checkpoint. Both are idempotent; `lib/dapp-server.js`
will retry transient failures from the catchup tick. The wiring matches
echo's and lastwin's: no `--wallet-owner` flag is needed on the sidecar.

## Direct-to-node live tail (opt-in)

Set `USE_NODE_STREAM=1` in `.env` to bypass the explorer's 5–60s indexing
lag for live transaction delivery. The cache replaces the explorer poller
for the `recipient` queryField with `createNodeRecentTxStream` (SSE +
catch-up poll against the sidecar's `/transactions/stream` and
`/transactions/by_recipient` endpoints). Off by default — needs a
sidecar usernode build that exposes those endpoints.

## App-specific conventions

- `APP_PUBKEY` and `SENDER_APP_PUBKEY` are deliberately separate: the
  former is a recipient-only address (every OM action is sent to it), the
  latter is the wallet that holds UTXOs and pays the gas-equivalent
  base-currency on `publish_pubkeys` / `reveal_key` sends. The canonical
  deploy reuses the lastwin pot keypair as the sender.
- Every survey's encryption keys are deterministically derived from
  `(VOTE_ENCRYPT_SEED, surveyId, intervalIndex)` — there's no key
  storage anywhere. As a consequence, **two servers with the same seed
  and the same surveyId always derive the same key pair**.
- `/__om/pubkeys/:surveyId` is intentionally public. It exposes per-survey
  public keys, identical for every viewer.
- `vote-encryption.js`'s producer-side checks
  (`entry.pubkeysPublished.has(batch)`, `entry.revealedIntervals.has(ki)`)
  are local-only — they don't read the chain. A restart re-runs every
  checkpoint that's currently in window. The on-chain consumer-side
  dedup (`seenTxIds` in vote-encryption + the cache itself) handles the
  resulting duplicate sends idempotently.

## Parallel deploys + same APP_PUBKEY

This repo and `usernode-dapp-starter`'s combined examples server deploy
independently and share `APP_PUBKEY`. **Both servers will publish
`publish_pubkeys` + `reveal_key` txs in parallel** for every survey:

- The first one to land wins; the second hits the cache's
  `seenTxIds` dedup and is ignored on read.
- The redundant on-chain spend is small (a couple of base-currency UTXOs
  per checkpoint).
- Hard correctness constraint: every co-operating server **must** derive
  the same key pairs. That requires the same `VOTE_ENCRYPT_SEED` (default
  unset → both deploys fall back to the dev-seed inside
  `vote-encryption.js`, which is what the canonical deploy uses today).
  If you ever set this in one place, set it in all of them in lockstep,
  or you'll silently lose the ability to decrypt votes encrypted against
  the other server's keys.

If you need single-publisher semantics later, gate the publish/reveal
work in `vote-encryption.js` behind a leader-elected flag, or pin
publication to one designated server and let the others stay
read-only.
