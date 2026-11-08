/**
 * Demo flow:  npm run buyer -- tenders hospitality
 *             npm run buyer -- benchmark "bath towel"
 * 1. Fetch the seller's Agent Card and check its Verified by Concordium badge.
 * 2. Call the paid endpoint; x402 handles 402 -> sign sponsored tx -> retry.
 * 3. Print the data, the finalized tx on CCDExplorer and the receipt hash.
 */
import { config } from "../lib/config.js";
import { checkBadge, verifyAgentCard } from "../lib/badge.js";
import { buy } from "./procurebot.js";

const [cmd = "tenders", arg = ""] = process.argv.slice(2);
const base = config.seller.url;

async function main() {
  const card = await fetch(`${base}/.well-known/agent-card.json`).then((r) => r.json()).catch(() => null);
  const ext = card?.capabilities?.extensions?.find((e: any) => String(e.uri).includes("concordium-badge"));
  const sellerBadge: string | undefined = ext?.params?.tokenAddress?.split(":").pop();
  console.log(`Seller: ${card?.name ?? "(no card)"}  badge: ${sellerBadge ?? "none"}`);
  if (sellerBadge) {
    const [b, c] = await Promise.all([checkBadge(sellerBadge), verifyAgentCard(sellerBadge)]);
    console.log(`  badge valid: ${b.verified}   card hash matches chain: ${c.match}`);
  }

  const url = cmd === "benchmark"
    ? `${base}/price-benchmark?item=${encodeURIComponent(arg || "bath towel")}`
    : `${base}/tenders${arg ? `?sector=${encodeURIComponent(arg)}` : ""}`;

  const r = await buy(url, `cli: ${cmd} ${arg}`.trim());
  console.log(JSON.stringify(r.data, null, 2));
  if (r.receipt) {
    console.log(`\nPaid ${r.receipt.amount} ${r.receipt.asset} (fee sponsored) -> ${r.receipt.sellerAccount}`);
    console.log(`Tx: ${r.receipt.explorerUrl ?? r.receipt.txHash}`);
    console.log(`Receipt #${r.receipt.seq} hash ${r.receipt.hash}`);
  }
}
main().catch((e) => { console.error("x", e.message); process.exit(1); });
