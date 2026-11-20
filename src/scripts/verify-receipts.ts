// npm run audit:verify — recompute the receipt chain and the audit log chain, and check every
// Concordium anchor still matches the local records. Exit code 1 if anything was tampered with.
import { readReceipts, verifyChain } from "../lib/receipts.js";
import { verifyAudit } from "../lib/audit.js";
import { checkAnchors } from "../lib/anchor.js";

const r = verifyChain();
const a = verifyAudit();
const anchors = checkAnchors();
const badAnchors = anchors.filter((x) => !x.auditMatches || !x.receiptsMatch);

console.log(r.ok ? `OK  receipts: ${r.count}, chain intact` : `TAMPERED  receipts: chain breaks at #${r.brokenAt}`);
console.log(a.ok ? `OK  audit log: ${a.count} entries, chain intact` : `TAMPERED  audit log: chain breaks at #${a.brokenAt}`);
console.log(anchors.length ? (badAnchors.length ? `TAMPERED  ${badAnchors.length} of ${anchors.length} anchors no longer match the records` : `OK  anchors: ${anchors.length}, all match (latest: audit #${anchors.at(-1)!.auditSeq}, tx ${anchors.at(-1)!.txHash})`) : "--  no Concordium anchors yet");
for (const x of anchors) console.log(`   anchor ${x.at} audit #${x.auditSeq} receipts #${x.receiptSeq} ${x.auditMatches && x.receiptsMatch ? "matches" : "MISMATCH"} ${x.explorerUrl}`);
for (const x of readReceipts()) console.log(`   receipt #${x.seq} ${x.ts} ${x.role} ${x.amount} ${x.asset} -> ${x.sellerAccount} tx ${x.txHash ?? "-"}`);
process.exit(r.ok && a.ok && !badAnchors.length ? 0 : 1);
