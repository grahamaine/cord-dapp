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
import { loadPolicy, policyViolation, type Policy } from "../lib/policy.js";
import { eurToAtomic } from "../lib/eur.js";
import { appendReceipt, type Receipt } from "../lib/receipts.js";

export interface PurchaseResult {
  data: unknown;
  receipt?: Receipt;
  sellerVerified: boolean;
}

let paidFetch: ReturnType<typeof wrapFetchWithPayment> | undefined;
let paidFetchPolicy = "";
let reservedEurForCall = 0; // budget set aside by OTHER locks, for the call in progress
type Selection = { payTo: string; amount: string; asset: string; verified: boolean };
let lastSelected: Selection | undefined;
let lastRefusal: string | undefined;

/** Thrown when the owner's policy or the trust gate refuses a payment (nothing was signed). */
export class PaymentRefused extends Error {}

function getPaidFetch(policy: Policy) {
  // Rebuild the x402 client whenever the owner changes the policy.
  const key = JSON.stringify(policy);
  if (paidFetch && key === paidFetchPolicy) return paidFetch;
  paidFetchPolicy = key;
  const scheme = new ExactConcordiumScheme(
    { accountAddress: AccountAddress.fromBase58(config.buyer.address()), signer: buildBasicAccountSigner(config.buyer.privateKey()) },
    { grpcUrl: `${config.grpc.host}:${config.grpc.port}`, useTls: true },
  );

  // x402 spend controls: only these assets, each capped per payment (atomic units).
  const client = new x402Client().register(config.network, scheme).setSpendControls({
    allowedAssets: policy.allowedAssets.map((asset) => ({
      network: config.network,
      asset,
      maxAmountPerPayment: policy.maxPerLockEur > 0 ? eurToAtomic(policy.maxPerLockEur) : "1000000000000000",
    })),
  });

  // Trust gate: runs after the 402 is received and BEFORE anything is signed.
  client.onBeforePaymentCreation(async ({ selectedRequirements: r }) => {
    const refuse = (reason: string) => {
      lastRefusal = reason;
      return { abort: true as const, reason };
    };
    const violation = policyViolation(policy, r.payTo, r.amount, r.asset, reservedEurForCall);
    if (violation) return refuse(violation);
    const v = await checkBadge(r.payTo);
    lastSelected = { payTo: r.payTo, amount: r.amount, asset: r.asset, verified: v.verified };
    if (!v.verified && policy.requireSellerBadge) {
      return refuse(`payee ${r.payTo} has no valid Verified by Concordium agent: ${v.issues.join("; ")}`);
    }
  });

  paidFetch = wrapFetchWithPayment(fetch, client);
  return paidFetch;
}

export async function buy(url: string, purpose: string, opts: { reservedEur?: number } = {}): Promise<PurchaseResult> {
  reservedEurForCall = opts.reservedEur ?? 0;
  lastSelected = undefined;
  lastRefusal = undefined;
  const headers: Record<string, string> = {};
  if (config.buyer.badge) headers["X-Agent-Badge"] = config.buyer.badge;

  const policy = loadPolicy();
  let res: Response;
  try {
    res = await getPaidFetch(policy)(url, { headers });
  } catch (e) {
    if (lastRefusal) throw new PaymentRefused(`refused before signing: ${lastRefusal}`);
    // x402's built-in spend controls run before our hook; report them in the same plain terms.
    const msg = (e as Error).message;
    if (/spendControls/i.test(msg)) {
      throw new PaymentRefused(
        /maxAmountPerPayment/.test(msg)
          ? `refused before signing: price is above the per-payment limit of €${policy.maxPerLockEur.toLocaleString()}`
          : `refused before signing: asset not allowed (allowed: ${policy.allowedAssets.join(", ")})`,
      );
    }
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} from ${url}: ${explain402(res, data)}`);

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

/** x402 puts the reason for a rejected payment in the PAYMENT-REQUIRED header (base64 JSON), not the body. */
function explain402(res: Response, data: unknown): string {
  const raw = res.headers.get("PAYMENT-REQUIRED") ?? res.headers.get("X-PAYMENT-REQUIRED");
  let reason = "";
  if (raw) {
    try {
      const j = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
      reason = j.error || j.errorReason || j.invalidReason || "";
    } catch { /* not base64 JSON */ }
  }
  const body = data && typeof data === "object" && Object.keys(data as object).length ? JSON.stringify(data) : "";
  const hint: Record<string, string> = {
    insufficient_funds: "the ProcureBot account doesn't have enough test CCD — top it up from the testnet faucet",
    preflight_insufficient_funds: "the ProcureBot account doesn't have enough test CCD — top it up from the testnet faucet",
  };
  const key = Object.keys(hint).find((k) => reason.includes(k));
  return [reason, key ? `(${hint[key]})` : "", body].filter(Boolean).join(" ") ||
    "payment rejected without a reason; check the seller and facilitator windows for the error";
}
