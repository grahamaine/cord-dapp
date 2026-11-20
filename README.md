# Cord: verified supplier payments for Ugandan businesses

AI agents that pay supplier invoices on Concordium, but **only to identity-verified agents**,
**only within limits the business owner sets**, with **network fees sponsored** and every payment
written to a **tamper-evident receipt trail**.

Built for the Concordium **"Make your Agents Accountable"** hackathon (Encode).

**Links**
- 🌐 Public site: https://cord-dapp.vercel.app (agents verified live, payments and account balances read from the chain)
- ✅ **Judge view: https://cord-dapp.vercel.app/judge**: the real records, re-checked against Concordium
- 🖥️ Owner dashboard: http://localhost:4030 (runs on the owner's computer only; it holds ProcureBot's key, see [Run it](#run-it-testnet))

**Live proof on Concordium testnet (20 Nov 2026).** The judge view's live check passes: audit log (37 entries) and
receipts (8) chains intact, all 3 anchors match their on-chain data, all 4 payments finalized.

| What happened | Amount | Who did it | Transaction |
|---|---|---|---|
| Laundry invoice paid | €1,850 | agent prepared, owner signed Release | [26f8ab55…](https://ccdexplorer.io/testnet/transaction/26f8ab55d0697e8dd1f4d01fe9fe40d4728b92a0ce6ce26abeb713830cf3fe0f) |
| Hospitality tender list bought | 0.1 CCD | agent, within the owner's limits | [4854b184…](https://ccdexplorer.io/testnet/transaction/4854b184bd49c8cbb8618a7e60b31176ed100c2d8e0685abafc948851a0746e6) |
| Airport transfers invoice paid | €980 | agent prepared, owner signed Release | [76d81e79…](https://ccdexplorer.io/testnet/transaction/76d81e795a083ee6fb03e78873aed1c8f8ae8e78ed281bc8c50e9ce6431f5226) |
| Plumbing invoice paid | €640 | owner, signed Release | [a3f1f201…](https://ccdexplorer.io/testnet/transaction/a3f1f201786f31265008b6a090dbc03265233aee2a486362bcd5603a7d3c1586) |
| Construction invoice **refused** | €12,500 | agent: over the €10,000 per-payment cap, nothing paid | in the audit log |
| Audit anchor: entries 1–19, receipts 1–2 | | owner | [12650e36…](https://ccdexplorer.io/testnet/transaction/12650e367d5ffb94482a9c4b87a8c08c3b5ec418e8e78a54b28888110614799c) |
| Audit anchor: entries 1–35, receipts 1–8 | | owner | [c5c36694…](https://ccdexplorer.io/testnet/transaction/c5c36694428de46b6d49d29d00399827ddf4eb347c54b6ab0911ec4b8b79ddca) |
| Audit anchor: entries 1–36, receipts 1–8 | | owner | [fb3325d2…](https://ccdexplorer.io/testnet/transaction/fb3325d2e26412b6bc1422857c45fb28d32d120aea9e0fa8de52261b4c398af2) |

Every payment was a sponsored transaction (the Cord facilitator paid the fee) to a supplier agent that is
**Verified by Concordium**. Both agents are verified (see [Live on testnet](#live-on-testnet)).

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
In the owner dashboard you can simply ask ProcureBot: *"pay the laundry invoice"*. It creates and funds a
payment lock and runs its checks; you then press **Release** and sign with your Concordium wallet. Under the hood:
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
| Wallet signatures (browser + WalletConnect) | `src/lib/approval.ts`: every Release is signed by an owner account and verified on-chain |
| CIS-8 external keys | `src/lib/xchain.ts`: verify suppliers on Base, Ethereum or Solana through their Concordium link |
| RegisterData anchoring | `src/lib/anchor.ts`: audit log + receipt hashes written on-chain |

## Payment locks: five operations, one human decision
Every invoice payment goes through a lock (`src/lib/locks.ts`). Amounts are in **demo EUR**; the default
limits are **€10,000 per lock and €10,000 per day**.

| Step | Who | What happens |
|---|---|---|
| 1. **Create** | owner | Opens a lock for one supplier invoice |
| 2. **Fund** | owner | Sets the amount aside against today's budget; refused if over a limit |
| 3. **Send** | AI agent | Checks the payee's Verified by Concordium badge and every owner rule, and records the result |
| 4. **Release** | **a person** | Approves; only now is the payment signed and settled on Concordium (fee sponsored) |
| 5. **Cancel** | owner | Stops the lock at any point before release; frees the budget |

**Owner wallet approval:** by default Release must also be **signed by the owner's Concordium wallet**.
Connect it from the owner page (top right): the Concordium browser extension, or the phone wallet by
scanning a WalletConnect QR code (needs a free `WALLETCONNECT_PROJECT_ID`). Cord issues a one-time
challenge naming the lock, invoice, supplier and amount; the wallet signs it; the server checks the
signature against the account's on-chain keys and that the account is an authorised owner
(`OWNER_ACCOUNTS`, default the buyer agent's owner). The signed approval is stored on the lock and in
the audit log.

"Fund" reserves budget in Cord's records; it does not move money into an on-chain escrow. Money moves once,
on release. On testnet each EUR amount settles as a small CCD amount at a fixed demo rate
(`DEMO_ATOMIC_PER_EUR`, default €1,000 = 0.1 CCD); in production invoices would be paid in a euro stablecoin.

## Suppliers on other blockchains
Agents on Ethereum, Base, Solana, Fetch.ai and other chains can link their key to a Concordium agent
through the **CIS-8 external key registry** (testnet contract `12801.0`). On the owner page
(Policy → *Suppliers on other blockchains*), pick the chain and paste the supplier's Solana address
or EVM public key, or let the supplier sign once with MetaMask so Cord can recover the key. Cord calls
the registry's `owner_of_key` and `agent_by_external_reference` tools, then runs the normal
Verified by Concordium badge check on the linked agent. A verified supplier can be added to the
approved list; payment still settles on Concordium to its verified owner account. Settling on the other
chain (x402 on Base or Solana) is planned. How to link a key: see `docs/cross-chain.md`.

## EU AI Act alignment
Cord prepares business-to-business supplier payments, which is not on the AI Act's high-risk list, but it
applies the Act's core safeguards by design:

| AI Act | How Cord does it |
|---|---|
| Art. 14 human oversight | Release needs a person who **signs with the owner's wallet**; the owner can cancel any lock or **pause the agent** (every payment refused while paused) |
| Art. 12 record-keeping | Hash-chained audit log of every operation, refusal and policy change (`data/audit.jsonl`) plus payment receipts, anchored on Concordium for an external timestamp |
| Art. 13 / 50 transparency | The Agent chat says up front that you're talking to an AI and labels every tool it used; the owner page tells users they're working with an AI agent and shows its checks and reasons before release |
| Art. 9 / 15 risk controls | Per-lock and daily limits, verified-supplier checks, refusal before any signature |
| Art. 26 deployer duties | Keep logs at least six months; assign named people to oversight |

Timing: Art. 50 transparency duties apply from 2 August 2026; after the 2026 Digital Omnibus, high-risk
obligations for stand-alone systems apply from 2 December 2027. This describes Cord's design, not legal advice.

## Owner dashboard (`npm run web`, http://localhost:4030)
- **Dashboard**: service status, account balances, badge status, every payment with its
  CCDExplorer link, and whether the receipt chain is intact.
- **Agent**: chat with ProcureBot in plain words. "What's due?", "Pay the laundry invoice", "How much budget
  is left?", "Find hospitality tenders", "Benchmark rice", "Verify 3wT8…", "Check solana <address>", "Cancel
  LCK-…", "Show the audit trail". It can **prepare** a payment (create → fund → agent checks) but has no way to
  release one: it points you to Locks, where you release with your wallet signature. Refusals (limits,
  unverified supplier, paused) are explained with the next step. Runs on a free built-in assistant on your
  computer; if `ANTHROPIC_API_KEY` is set, Claude drives the same tools instead. Any action that changes
  something or buys data is written to the audit log as an AI-agent action.
- **Locks**: supplier invoices, the five lock operations, and today's budget (released + set aside vs limit).
- **Policy**: per-lock and daily limits in EUR, allowed assets, "only pay Verified by Concordium suppliers",
  "a person must release every payment", and an approved-supplier list (saved to `data/policy.json`).
- **Audit log**: the audit trail. Every operation with who did it (owner or AI agent), the outcome and the
  reason; filters by date, operation, who and outcome, plus free-text search. **Anchor now** writes the latest
  audit and receipt hashes into a Concordium `RegisterData` transaction (sent from the ProcureBot owner
  account), so anyone can prove on CCDExplorer that the records weren't changed afterwards.
- **Trail** (on each lock): the full story of one payment: created → funded → agent checks → owner's signed
  approval → on-chain payment → buyer and seller receipts → which anchor covers it.
- **Wallet / switch account** (top right): connect the browser or mobile wallet, then click the account button to
  switch between the accounts you've connected (each marked owner or not), add more accounts from the wallet,
  change wallet, or disconnect. Switching account inside the Concordium wallet extension also switches it in Cord,
  and the connection is restored on reload without a new prompt. Only an owner account can sign a Release.
- **Pause agent** (top right): stops all payments until resumed.

The web server holds the buyer's signing key, so it listens on localhost only.

### Use the agent from your phone (`npm run remote`)
1. Set `DASHBOARD_PASSWORD` (12+ characters) in `.env` and restart `npm run web`. The dashboard now asks for the
   password; 5 wrong tries lock that address out for 15 minutes, and every sign-in is in the audit log.
2. Install cloudflared once (Windows: `winget install --id Cloudflare.cloudflared`).
3. `npm run remote` opens a free Cloudflare quick tunnel to the dashboard and prints a private HTTPS link and a
   QR code. Scan it, sign in, and use the Agent, Locks and Release on your phone. The dashboard and keys stay on
   your computer; the link changes each time and closes with Ctrl+C.
4. On the same phone, **Connect wallet → Mobile wallet → Open Concordium Wallet** opens the testnet Concordium
   Wallet app (the separate testnet build, not the app-store one) to approve; Release signing works the same way.

Without `DASHBOARD_PASSWORD`, any request arriving through a tunnel is refused, so the dashboard can't be exposed by accident.

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
3. **Install:** `npm install`, then `npm run doctor`. It checks that each private key belongs to its account and
   that the accounts hold enough CCD, without printing any key. A facilitator key from the wrong account makes
   payments fail with `submission_failed: Verification failed`.
4. **Start three services**, each in its own terminal, in this order:
   ```
   npm run facilitator     # :4020, sponsors fees
   npm run seller          # :4021, supplier agent + invoices
   npm run web             # :4030, dashboard + owner page
   ```
5. **Pay.** Open http://localhost:4030, **Connect wallet** (an owner account), then either ask the **Agent** tab
   "pay the plumbing invoice", or go to Locks → Create lock → Fund → Send to agent. Press **Release** and sign in
   your wallet, then **Anchor now** in the Audit log. Or use the CLI:
   `npm run buyer -- tenders hospitality`.
6. **Publish for judges.** `npm run publish:judge` copies the records (no keys) into `judge/snapshot.json`, commits
   and pushes it; Vercel then serves https://cord-dapp.vercel.app/judge. That page recomputes the audit and receipt
   hash chains and asks the Concordium node whether each anchor and payment is finalized with matching data,
   so an edited snapshot shows as broken. Press **Anchor now** before publishing so every entry is covered.
7. **Audit.** `npm run audit:verify` re-checks the receipt chain, the audit log chain and every Concordium
   anchor (exit code 1 if anything was altered). `npm run badge -- <account or badge>` checks a badge.

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
**Checkpoint 1 (22 Nov 2026): done on testnet.**
- [x] Both agents registered with valid Verified by Concordium badges (#1283, #1288)
- [x] Five-operation payment locks with demo-EUR limits (€10,000 per payment and per day), pause, approved suppliers
- [x] ProcureBot chat in the dashboard (free built-in assistant; Claude optional) that prepares but never releases
- [x] Owner wallet-signed Release (browser extension and mobile WalletConnect), switching between owner accounts
- [x] 4 sponsored x402 payments settled on testnet, plus a refused over-cap invoice (table at the top)
- [x] Hash-chained audit log + per-payment trail, anchored on Concordium 3 times
- [x] Public judge view that re-verifies the records against Concordium, online without the owner's PC
- [x] Owner login and a private phone link (`npm run remote`), phone-friendly dashboard
- [x] Cross-chain supplier verification via CIS-8 (Base, Ethereum, Solana)
- [x] `npm run doctor` and `npm run audit:verify` checks

**Next (final, 9 Dec):** euro stablecoin pricing, settlement on Base and Solana, real supplier and tender data,
demo video. Invoice, tender and price data in `src/seller/data.ts` is still sample data.
