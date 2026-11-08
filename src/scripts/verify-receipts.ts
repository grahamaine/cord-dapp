// npm run audit:verify  — recompute the receipt hash chain and report tampering
import { readReceipts, verifyChain } from "../lib/receipts.js";
const r = verifyChain();
console.log(r.ok ? `OK: ${r.count} receipts, chain intact` : `TAMPERED: chain breaks at receipt #${r.brokenAt}`);
for (const x of readReceipts()) console.log(`#${x.seq} ${x.ts} ${x.role} ${x.amount} ${x.asset} -> ${x.sellerAccount} tx ${x.txHash ?? "-"}`);
process.exit(r.ok ? 0 : 1);
