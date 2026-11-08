/**
 * ProcureBot: a buyer agent (e.g. a hotel's purchasing assistant) that buys data from
 * other agents over x402, with three accountability guarantees:
 *   1. It only pays a recipient whose account owns an Active, Verified by Concordium agent.
 *   2. It never pays above a hard per-payment spend cap.
 *   3. Every payment is written to a tamper-evident receipt log with the finalized tx hash.
 * Fees are sponsored by the facilitator, so the buyer's account needs no CCD for gas.
 */
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactConcordiumScheme } from "@x402/concordium/exact/client";
import { getExplorerTxUrl } from "@x402/concordium";
import { AccountAddress, buildBasicAccountSigner } from "@concordium/web-sdk";
import { config } from "../lib/config.js";
import { checkBadge } from "../lib/badge.js";
import { appendReceipt, type Receipt } from "../lib/receipts.js";

export interface PurchaseResult {
  data: unknown;
  receipt?: Receipt;
  sellerVerified: boolean;
}

let paidFetch: ReturnType<typeof wrapFetchWithPayment> | undefined;
type Selection = { payTo: string; amount: string; asset: string; verified: boolean };
let lastSelected: Selection | undefined;

function getPaidFetch() {
  if (paidFetch) return paidFetch;
  const scheme = new ExactConcordiumScheme(
    { accountAddress: AccountAddress.fromBase58(config.buyer.address()), signer: buildBasicAccountSigner(config.buyer.privateKey()) },
    { grpcUrl: `${config.grpc.host}:${config.grpc.port}`, useTls: true },
  );

  // x402 spend controls: only these assets, each capped per payment (atomic units).
  const client = new x402Client().register(config.network, scheme).setSpendControls({
    allowedAssets: config.buyer.allowedAssets.map((asset) => ({
      network: config.network,
      asset,
      maxAmountPerPayment: config.buyer.maxPayment.toString(),
    })),
  });

  // Trust gate: runs after the 402 is received and BEFORE anything is signed.
  client.onBeforePaymentCreation(async ({ selectedRequirements: r }) => {
    if (BigInt(r.amount) > config.buyer.maxPayment) {
      return { abort: true as const, reason: `amount ${r.amount} exceeds spend cap ${config.buyer.maxPayment}` };
    }
    const v = await checkBadge(r.payTo);
    lastSelected = { payTo: r.payTo, amount: r.amount, asset: r.asset, verified: v.verified };
    if (!v.verified && config.buyer.requireSellerBadge) {
      return { abort: true as const, reason: `payee ${r.payTo} has no valid Verified by Concordium agent: ${v.issues.join("; ")}` };
    }
  });

  paidFetch = wrapFetchWithPayment(fetch, client);
  return paidFetch;
}

export async function buy(url: string, purpose: string): Promise<PurchaseResult> {
  lastSelected = undefined;
  const headers: Record<string, string> = {};
  if (config.buyer.badge) headers["X-Agent-Badge"] = config.buyer.badge;

  const res = await getPaidFetch()(url, { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} from ${url}: ${JSON.stringify(data)}`);

  const header = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
  const sel = lastSelected as Selection | undefined; // set by the pre-payment hook during the fetch
  if (!header || !sel) return { data, sellerVerified: false };

  const settle = decodePaymentResponseHeader(header);
  const receipt = appendReceipt({
    role: "buyer",
    resource: url,
    purpose,
    buyerAccount: config.buyer.address(),
    buyerBadge: config.buyer.badge || undefined,
    sellerAccount: sel.payTo,
    amount: sel.amount,
    asset: sel.asset,
    network: config.network,
    txHash: settle.transaction,
    explorerUrl: getExplorerTxUrl(config.network, settle.transaction),
  });
  return { data, receipt, sellerVerified: sel.verified };
}
