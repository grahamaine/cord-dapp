# Cord — trust-gated agent commerce on Concordium

Verified agents buying and selling procurement intelligence over **x402**, with **sponsored
fees**, **Verified by Concordium** badge checks on both sides, and a **tamper-evident receipt
trail**. Built for the Concordium "Make your Agents Accountable" hackathon. See `PLAN.md`.

```
 ProcureBot (buyer)            TenderScout (seller)          Cord facilitator          Concordium testnet
   | GET /tenders + X-Agent-Badge ->|                              |                          |
   |                    badge check (registry API)                 |                          |
   |<- 402 PaymentRequirements -----|                              |                          |
   | badge check payTo + spend cap  |                              |                          |
   | sign V1 sponsored tx (no gas)  |                              |                          |
   |-- retry + PAYMENT-SIGNATURE -->|-- verify / settle ---------->| add sponsor sig, submit ->|
   |                                |<------------- finalized tx --|<-------------------------|
   |<- 200 data + PAYMENT-RESPONSE -|                              |                          |
 receipt (hash chain)          receipt (hash chain)
```

## Components used
| Concordium component | Where |
|---|---|
| x402 (`@x402/concordium`, exact scheme) | `src/seller/server.ts`, `src/buyer/procurebot.ts` |
| Sponsored transactions | `src/facilitator/server.ts` (our facilitator pays every fee) |
| Agent Registry (CIS-8004) + Agent Card | `src/scripts/build-card.ts`, `/.well-known/agent-card.json` |
| Verified by Concordium badge | `src/lib/badge.ts`, enforced in seller middleware and buyer pre-payment hook |
| Protocol-Level Tokens | set `PRICE_ASSET=USDR` (or your testnet PLT) |
| MCP | `src/mcp/server.ts` exposes ProcureBot to Claude/any MCP client |

## Quick start (testnet)
1. Create 3 testnet accounts in Concordium Wallet for Web (buyer, seller, facilitator); request test CCD for each. Export each account's private key.
2. `cp .env.example .env` and fill in addresses/keys. For a first run set `REQUIRE_SELLER_BADGE=false` and `REQUIRE_BUYER_BADGE=false`.
3. `npm install`
4. Three terminals:
   ```
   npm run facilitator
   npm run card -- seller && npm run seller
   npm run buyer -- tenders hospitality
   ```
5. Register both agents at https://agent-registry.concordium.com (testnet), using the card URL + SHA-256 printed by `npm run card`. Put the badges in `.env`, re-run `npm run card -- seller`, update the agent URI/hash, and set the `REQUIRE_*` flags back to `true`.
6. `npm run audit:verify` checks the receipt chain.

Seller data in `src/seller/data.ts` is sample data.
