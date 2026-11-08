# Cord — build plan (Concordium "Make your Agents Accountable" hackathon)

**One line:** Agents buy and sell procurement intelligence over x402 on Concordium, but only
from identity-backed agents, within spend limits, with fees sponsored and every deal on a
tamper-evident receipt trail.

## Why this concept scores
| Criterion | How Cord answers it |
|---|---|
| Depth of integration | Uses 5 components together: Agent Registry (CIS-8004) + Agent Card, Verified by Concordium badge (checked by BOTH sides before money moves), x402 `exact` scheme, sponsored transactions (own facilitator), PLT stablecoin pricing (USDR/EURR) with CCD fallback. Optional 6th: Agent Registry MCP. |
| Path to production | Real buyer (hotel purchasing, Graham's day job) and real seller domain (public tenders + supplier prices, 15 yrs procurement). Mainnet = swap CAIP-2 + registry contract + USDR; facilitator becomes a paid service. |
| It works | One CLI command shows: card check -> badge check -> 402 -> sponsored payment -> finalized tx on CCDExplorer -> receipt. |
| Usefulness | Agents paying unknown agents is the core risk of agent commerce; Cord makes "who is behind this payee?" a precondition of paying. |

## The trust gate (the differentiator)
1. Buyer sends `X-Agent-Badge`; seller refuses unverified buyers **before** quoting a price.
2. Seller returns 402 with `payTo`. Buyer's x402 `onBeforePaymentCreation` hook checks the
   `payTo` account owns an Active badged agent, and the amount is under the spend cap.
   Nothing is signed otherwise.
3. Facilitator verifies 9 rules, adds sponsor signature, waits for finality.
4. Both sides append a hash-chained receipt (Article 12-style record keeping); the chain
   links each payment to two badges, i.e. two accountable, identity-verified owners.

## Milestones (today: 8 Nov)
- [ ] **By 18 Nov (workshops):** testnet wallets x3 (buyer, seller, facilitator), faucet CCD, `npm run facilitator/seller/buyer` working end to end with `REQUIRE_*_BADGE=false`.
- [ ] **19–22 Nov:** register TenderScout + ProcureBot in the Agent Registry (testnet), anchor cards, turn badge gates on. **Submit Checkpoint 1 by 22 Nov 23:59 UTC.**
- [ ] **23–29 Nov:** request a testnet PLT (or use USDR if available), switch pricing to stablecoin; MCP server driven from Claude Desktop ("find hospitality tenders and benchmark towel prices for under 1 USDR").
- [ ] **30 Nov–5 Dec:** small web dashboard (receipts, badges, explorer links); deploy seller + facilitator (Vercel/Render/Fly); real data source for tenders (PPDA/GPP scraper) behind the same API. Use office hours Tue/Fri 15:00 UTC.
- [ ] **6–8 Dec:** 3-min demo video, README, CCDExplorer links, path-to-production write-up.
- [ ] **9 Dec 23:59 UTC:** submit.

## Open questions to settle in workshops / office hours
- Testnet CIS-8004 + CIS-8 contract indexes (registry `contract_info` tool on testnet).
- Whether the badge check attests a verified-human owner directly, or we add a Concordium ID / Verify and Access proof for the owner.
- USDR availability on testnet vs requesting our own PLT.
- Is there a hosted testnet x402 facilitator? (We run our own either way; it's part of the story.)

## Path to production (draft)
Mainnet CAIP-2 `ccd:9dd9ca4d19e9393877d2c44b70f89acb`, registry `<10082,0>`; price in USDR; facilitator
run as a service charging a small spread; seller data from licensed/public procurement feeds;
receipts mirrored to object storage + periodically anchored on-chain (hash of chain head);
buyer spend policies per owner; lawful-disclosure route via Concordium ID for disputes.
