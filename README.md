# Opinion Market

A prediction-market-powered survey app on the Usernode chain. Users
create surveys, cast encrypted votes, and (for monetary surveys) trade
outcome shares. All state lives on-chain as JSON-memo transactions sent
to a shared `APP_PUBKEY` address. The server-side process derives
per-survey encryption key pairs from `VOTE_ENCRYPT_SEED`, publishes
public keys immediately so clients can encrypt, and reveals matching
private keys at each configured reveal checkpoint so historical votes
become auditable.

Designed to run as a child app inside Usernode Social Vibecoding, but also
works standalone (mobile WebView or desktop QR) when fronted by a node.

## Quick start

```bash
npm install
npm run dev          # mock mode at http://localhost:3000
```

For production:

```bash
cp .env.example .env # fill in APP_PUBKEY, SENDER_APP_PUBKEY, SENDER_APP_SECRET_KEY
npm start
```

## Layout

```
opinion-market/
  server.js               Express server: mock API, OM-specific routes,
                          explorer proxy, static, recipient chain poller,
                          sidecar status probe, /status.
  vote-encryption.js      Per-survey ECDH key derivation + on-chain
                          publish_pubkeys / reveal_key publication.
  lib/
    dapp-server.js        Vendored helpers (mock API, chain poller,
                          explorer proxy, env loader, status probe).
                          Source: usernode-dapp-starter.
    tx-match.js           Vendored helper for matching txs to bridge waiters.
  public/
    index.html              UI (single-file HTML/CSS/JS — byte-identical
                            to the canonical opinion-market.html source).
    opinion-market-core.js  CPMM market math + survey rendering.
    usernode-bridge.js
    usernode-usernames.js
    usernode-loading.js
  Dockerfile              node:22-alpine, port 3000, /health probe.
  .env.example
  dapp.json               Platform secrets schema.
  CLAUDE.md               App-specific notes for AI tooling.
```

## How it works

```
client ──► sendTransaction(APP_PUBKEY, 1, {app:"opinion-market", type:…})
                          │
                          ▼
              [Usernode Blockchain]
                          │
              recipient poller picks it up
                          │
                          ▼
              vote-encryption.processTransaction
                          │
                ┌─────────┼──────────────────────────────────┐
                ▼         ▼                                  ▼
          create_survey  vote / add_option / set_username   publish_pubkeys / reveal_key
                │            │                                 (consumer-side dedup
                │            │                                  via seenTxIds)
                ▼            ▼
       register surveyId    raw tx kept in
       schedule pubkeys     omCache for client
       schedule reveals     to derive market state
                │
       /wallet/send (publish_pubkeys, reveal_key)
                │
                ▼
        [Usernode Blockchain]
                │
       recipient poller catches the publish/reveal
                │
                ▼
       /opinion-market/api/transactions exposes the raw stream
       /__om/pubkeys/:surveyId is the HTTP fallback for clients that
       race ahead of the on-chain publish_pubkeys
```

The cache exposes raw transactions to the client (newest-first); the
client re-derives market state from the raw stream. The server keeps
per-survey state only long enough to schedule key publication.

## Memo schema

```js
// client → OM (survey)
{ app: "opinion-market", type: "create_survey", survey: { id, …config } }

// client → OM (encrypted vote)
{ app: "opinion-market", type: "vote", survey: "<id>", ciphertext: "<b64>", interval: <i> }

// client → OM (custom option)
{ app: "opinion-market", type: "add_option", survey: "<id>", option: { key, label } }

// client → OM (display name; also published to global usernames address)
{ app: "opinion-market", type: "set_username", username: "alice" }

// server → OM (per-survey public keys)
{ app: "opinion-market", type: "publish_pubkeys", survey: "<id>", batch: <n>, pubkeys: [ "<b64>", … ] }

// server → OM (reveal at checkpoint)
{ app: "opinion-market", type: "reveal_key", survey: "<id>", interval: <i>, jwk: { … } }
```

## Configuration

| Var | Purpose |
| --- | --- |
| `APP_PUBKEY` | OM dapp's read-only address (recipient of every OM action). Default: canonical OM `ut1zkj9p…l3mlms`. |
| `ADMIN_PUBKEY` | Address allowed to create surveys. Empty → everyone. |
| `SENDER_APP_PUBKEY` | Sender pubkey for the encryption-key publication wallet. Distinct from `APP_PUBKEY` because /wallet/send needs UTXOs at the sender. Canonical deploy reuses the lastwin pot keypair. |
| `SENDER_APP_SECRET_KEY` | Secret half of `SENDER_APP_PUBKEY`. |
| `VOTE_ENCRYPT_SEED` | Hex/string seed for per-survey ECDH key derivation. **Must match every server using the same `APP_PUBKEY`** or votes encrypted against one server can't be decrypted by the other. Default unset → falls back to dev-seed (matches the canonical deploy). |
| `NODE_RPC_URL` | Sidecar URL. Default `http://usernode-node:3000` (compose internal). |
| `PORT` | HTTP port (default 3000). |

## Origin

Forked from [`usernode-dapp-starter/examples/opinion-market`](https://github.com/Usernode-Labs/usernode-dapp-starter)
and adapted into a standalone repo so it can be deployed as an
independently-versioned child app on social-vibecoding. Behavioral
duplicate of the canonical combined-examples deploy at
`https://dapps.usernodelabs.org/opinion-market` — same `APP_PUBKEY`,
same `ADMIN_PUBKEY`, same `VOTE_ENCRYPT_SEED` default → both servers
derive identical key pairs and either deploy can decrypt votes encrypted
against the other.
