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

## Owner dashboard (`npm run web`)
With the facilitator and seller running, start the web UI in a fourth terminal and open http://localhost:4030.

- **Dashboard**: service status, account balances and Verified by Concordium badges, every payment with its
  CCDExplorer link, and whether the hash-chained receipt log is intact.
- **Owner**: supplier invoices (Ugandan hotel suppliers, sample data) with a **Pay** button, plus the spending
  policy the agent must obey before signing anything: max per payment, daily limit, allowed assets,
  "only Verified by Concordium payees", and an approved-supplier list. Saved to `data/policy.json`.

Paying an invoice runs the same trust-gated x402 flow as the CLI: the seller quotes the invoice amount (402),
ProcureBot checks the owner policy and the payee's badge, signs a sponsored transaction, the facilitator settles
it, and both sides add a receipt. Already-paid invoices are refused before a price is quoted.

The web server holds the buyer's key, so it only listens on localhost. Don't expose it without authentication.
