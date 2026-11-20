# Cord: verified supplier payments for Ugandan businesses

AI agents that pay supplier invoices on Concordium, but **only to identity-verified agents**,
**only within limits the business owner sets**, with **network fees sponsored** and every payment
written to a **tamper-evident receipt trail**.

Built for the Concordium **"Make your Agents Accountable"** hackathon (Encode).

**Who it's for:** any Ugandan organisation that regularly pays service providers and suppliers —
hotels and hospitality, hospitals and clinics, schools and universities, NGOs and project offices,
construction and facilities firms, logistics companies, and public bodies running procurement.

**Lead example:** a hotel in Entebbe paying its regular providers — laundry, fresh produce, airport
transfers, maintenance. The same flow covers other recurring service bills: security, cleaning,
internet and telecoms, utilities, fuel, catering, transport and equipment servicing.

## The problem
Ugandan organisations pay many service providers and suppliers, large and small. The recurring risks are fake or duplicate suppliers,
unauthorised or oversized payments, and missing records at audit time. Once AI agents start making
these payments, the risks grow, because an agent can't tell who is really behind a payee.

Cord makes "who owns this payee, and is this payment allowed?" a precondition of every payment.

## How it works
```
 Owner page / CLI        ProcureBot (buyer)          TenderScout (supplier agent)   Cord facilitator     Concordium
      | Pay invoice ------>| GET /invoices/:id/pay + X-Agent-Badge ->|                      |                  |
      |                    |               buyer badge check (registry)                     |                  |
      |                    |<- 402 price for this invoice -----------|                      |                  |
      |                    | owner policy: cap, daily limit, assets, approved payee         |                  |
      |                    | payee badge check (registry)            |                      |                  |
      |                    | sign sponsored tx (buyer pays no fee)   |                      |                  |
      |                    |-- retry + PAYMENT-SIGNATURE ----------->|-- verify / settle -->| sponsor + submit>|
      |                    |<- 200 paid + PAYMENT-RESPONSE ----------|<------ finalized ---|<-----------------|
      |<- receipt + CCDExplorer link            both sides append a hash-chained receipt
```
Anything that fails a rule is refused **before** a signature exists, with a plain reason
(for example "daily limit reached" or "payee has no valid Verified by Concordium agent").

## Live on testnet
| Agent | Role | Agent # | Badge | Card |
|---|---|---|---|---|
| TenderScout | supplier agent (gets paid) | 1283 | `JyP9TwhskJ6cKHDzW23Yj` | https://cord-dapp.vercel.app/.well-known/agent-card.json |
| ProcureBot | purchasing agent (pays; demo configured for a hotel) | 1288 | `JyP9U3BHQRbFTuQx4N1Gn` | https://cord-dapp.vercel.app/procurebot/.well-known/agent-card.json |

Both pass the registry badge check (`badge_valid: true`):
https://agent-registry-mcp.concordium.com/v1/badge-check/JyP9TwhskJ6cKHDzW23Yj ·
https://agent-registry-mcp.concordium.com/v1/badge-check/JyP9U3BHQRbFTuQx4N1Gn

## Concordium components used
| Component | Where |
|---|---|
| x402 payments (`@x402/concordium`, exact scheme) | `src/seller/server.ts`, `src/buyer/procurebot.ts` |
| Sponsored transactions | `src/facilitator/server.ts`: Cord's facilitator pays every network fee |
| Agent Registry (CIS-8004) + Agent Cards | `src/scripts/build-card.ts`, served at `/.well-known/agent-card.json` |
| Verified by Concordium badge | `src/lib/badge.ts`: checked by the seller (buyer badge) and the buyer (payee badge) |
| Protocol-Level Tokens | set `PRICE_ASSET` / `ALLOWED_ASSETS` to a PLT such as USDR (planned) |
| MCP | `src/mcp/server.ts` lets Claude or any MCP client drive ProcureBot |

## Owner dashboard (`npm run web`, http://localhost:4030)
- **Dashboard**: service status, account balances, badge status, every payment with its
  CCDExplorer link, and whether the receipt chain is intact.
- **Owner**: supplier invoices with a **Pay** button, plus the spending policy the agent must obey:
  max per payment, daily limit, allowed assets, "only pay Verified by Concordium suppliers", and an
  approved-supplier list (saved to `data/policy.json`). Already-paid invoices are refused before a
  price is quoted, so nothing is paid twice.

The web server holds the buyer's signing key, so it listens on localhost only. Don't expose it without authentication.

## Run it (testnet)
Requires Node.js 20+. On Windows PowerShell, use `npm.cmd` in place of `npm`, or run
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.

1. **Accounts.** Create three testnet accounts in a Concordium wallet: buyer, seller, facilitator.
   Fund the buyer and facilitator (each account can claim test CCD once, while it has no incoming transfers):
   ```powershell
   Invoke-RestMethod -Method Put -Uri "https://wallet-proxy.testnet.concordium.com/v0/testnetGTUDrop/<ACCOUNT_ADDRESS>"
   ```
2. **Config.** `cp .env.example .env` and fill in:
   - buyer: `CCD_ADDRESS`, `CCD_PRIVATE_KEY`
   - seller: `SELLER_PAY_TO` (address only)
   - facilitator: `CCD_FACILITATOR_ADDRESS`, `CCD_FACILITATOR_PRIVATE_KEY`
   - badges, once registered: `SELLER_BADGE`, `SELLER_TOKEN_ID`, `BUYER_BADGE`, `BUYER_TOKEN_ID`, `REQUIRE_*_BADGE=true`

   For a first run without badges, set `REQUIRE_BUYER_BADGE=false` and `REQUIRE_SELLER_BADGE=false`.
3. **Install:** `npm install`
4. **Start three services**, each in its own terminal, in this order:
   ```
   npm run facilitator     # :4020, sponsors fees
   npm run seller          # :4021, supplier agent + invoices
   npm run web             # :4030, dashboard + owner page
   ```
5. **Pay.** Open http://localhost:4030 → Owner → Pay an invoice. Or use the CLI:
   `npm run buyer -- tenders hospitality`.
6. **Audit.** `npm run audit:verify` checks the receipt hash chain. `npm run badge -- <account or badge>` checks a badge.

## Registering an agent (what worked)
The registry website can't edit an agent after registering it, and its form pins its own hash. Cord uses the
registry's developer tools at `https://agent-registry-mcp.concordium.com/mcp` instead:
1. Host the card publicly (Vercel serves `data/agent-card.*.json`; no private keys are stored there).
2. `build_register` with the card URL and its SHA-256 → sign with the owner's wallet → note the new token id.
3. `build_agent_badge` (or `npm run card -- seller|buyer` with the badge env vars) to add the badge block,
   then deploy the updated card.
4. `build_set_agent_uri` with the new SHA-256 → sign. The badge check should now report `badge_valid: true`.

Dry-run each transaction with `invokeContract` first, and let the wallet encode parameters from the
contract's embedded schema. Testnet contracts: CIS-8004 `12802.0`, CIS-8 `12801.0`.

## Path to production
Mainnet network + registry contract; invoices priced in a stablecoin (USDR) at full value; the facilitator
run as a paid service; pilots with organisations in several sectors (starting with hospitality, then
health, education and NGOs), each with its own buyer agent and spending policy; service providers
registering their own verified supplier agents; receipts mirrored to storage and periodically
anchored on-chain; per-owner spending policies; and supplier cash-out to mobile money through a licensed
partner (planned, not built).

## Status
Testnet. Invoice, tender and price data in `src/seller/data.ts` is sample data. Plan and milestones: `PLAN.md`.
