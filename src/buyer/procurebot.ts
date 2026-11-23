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
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { base58 } from "@scure/base";
import { AccountAddress, buildBasicAccountSigner } from "@concordium/web-sdk";
import { config } from "../lib/config.js";
import { verifyPayee } from "../lib/payee.js";
import { XCHAINS, assetSymbol, buyerXKey, chainByNetwork, explorerTx } from "../lib/chains.js";
import { loadPolicy, policyViolation, type Policy } from "../lib/policy.js";
import { eurToAtomic, unpriceable } from "../lib/eur.js";
import { appendReceipt, type Receipt } from "../lib/receipts.js";

export interface PurchaseResult {
  data: unknown;
  receipt?: Receipt;
  sellerVerified: boolean;
}

let paidFetch: ReturnType<typeof wrapFetchWithPayment> | undefined;
let paidFetchPolicy = "";
let reservedEurForCall = 0; // budget set aside by OTHER locks, for the call in progress
type Selection = { payTo: string; amount: string; asset: string; network: string; verified: boolean; owner: string | null };
let lastSelected: Selection | undefined;
let lastRefusal: string | undefined;

/** Thrown when the owner's policy or the trust gate refuses a payment (nothing was signed). */
export class PaymentRefused extends Error {}

/** ProcureBot's own wallets on Base / Solana (only if their keys are in .env). */
export function buyerXAddresses(): Partial<Record<"base" | "solana", string>> {
  const out: Partial<Record<"base" | "solana", string>> = {};
  const evm = buyerXKey.base();
  if (evm) out.base = privateKeyToAccount(evm.startsWith("0x") ? (evm as `0x${string}`) : `0x${evm}`).address;
  if (solanaSigner) out.solana = String(solanaSigner.address);
  return out;
}
let solanaSigner: KeyPairSigner | undefined;
let solanaInit: Promise<void> | undefined;
async function initSolana() {
  const secret = buyerXKey.solana();
  if (!secret || solanaSigner) return;
  const bytes = secret.trim().startsWith("[") ? Uint8Array.from(JSON.parse(secret)) : base58.decode(secret.trim());
  solanaSigner = await createKeyPairSignerFromBytes(bytes);
}

async function getPaidFetch(policy: Policy) {
  await (solanaInit ??= initSolana());
  // Rebuild the x402 client whenever the owner changes the policy.
  const key = JSON.stringify(policy);
  if (paidFetch && key === paidFetchPolicy) return paidFetch;
  paidFetchPolicy = key;
  const scheme = new ExactConcordiumScheme(
    { accountAddress: AccountAddress.fromBase58(config.buyer.address()), signer: buildBasicAccountSigner(config.buyer.privateKey()) },
    { grpcUrl: `${config.grpc.host}:${config.grpc.port}`, useTls: true },
  );
  const client = new x402Client().register(config.network, scheme);

  // Base Sepolia / Solana devnet: EURC through the public x402 facilitator, which pays the network fee,
  // so ProcureBot needs no ETH or SOL. Registered only when ProcureBot has a key on that chain.
  const evmKey = buyerXKey.base();
  if (evmKey) {
    const account = privateKeyToAccount(evmKey.startsWith("0x") ? (evmKey as `0x${string}`) : `0x${evmKey}`);
    const publicClient = createPublicClient({ chain: baseSepolia, transport: http(XCHAINS.base.rpcUrl) });
    client.register(XCHAINS.base.network, new ExactEvmScheme(toClientEvmSigner(account, publicClient as any)));
  }
  if (solanaSigner) client.register(XCHAINS.solana.network, new ExactSvmScheme(solanaSigner, { rpcUrl: XCHAINS.solana.rpcUrl }));

  // x402 spend controls: only these assets, each capped per payment (atomic units). On Base / Solana the
  // requirement names the token contract / mint, so each policy symbol maps to that chain's token.
  const cap = (asset: string) =>
    // Per-asset cap in that asset's atomic units. An asset with no EUR rate gets no x402 cap here;
    // the pre-payment hook below refuses it with a plain reason instead.
    policy.maxPerLockEur > 0 && !unpriceable(asset) ? eurToAtomic(policy.maxPerLockEur, asset) : "1000000000000000000000";
  client.setSpendControls({
    allowedAssets: [
      ...policy.allowedAssets.map((asset) => ({ network: config.network, asset, maxAmountPerPayment: cap(asset) })),
      ...Object.values(XCHAINS)
        .filter((x) => policy.allowedAssets.includes(x.asset))
        .map((x) => ({ network: x.network, asset: x.token, maxAmountPerPayment: cap(x.asset) })),
    ],
  });

  // Trust gate: runs after the 402 is received and BEFORE anything is signed.
  client.onBeforePaymentCreation(async ({ selectedRequirements: r }) => {
    const refuse = (reason: string) => {
      lastRefusal = reason;
      return { abort: true as const, reason };
    };
    const symbol = assetSymbol(r.network, r.asset);
    const violation = policyViolation(policy, r.payTo, r.amount, symbol, reservedEurForCall);
    if (violation) return refuse(violation);
    // Concordium: the payee owns a Verified by Concordium agent. Base / Solana: the payee's key is linked
    // through CIS-8 to an identity-verified Concordium owner.
    const v = await verifyPayee(r.network, r.payTo);
    lastSelected = { payTo: r.payTo, amount: r.amount, asset: symbol, network: r.network, verified: v.verified, owner: v.owner };
    if (!v.verified && policy.requireSellerBadge) {
      const x = chainByNetwork(r.network);
      return refuse(x
        ? `${x.name} payee ${r.payTo} is not linked to a Verified by Concordium owner: ${v.summary}`
        : `payee ${r.payTo} has no valid Verified by Concordium agent: ${v.issues.join("; ")}`);
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
    res = await (await getPaidFetch(policy))(url, { headers });
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
    buyerBadge: config.buyer.badge || undefined,
    buyerAccount: chainByNetwork(sel.network) ? (settle.payer || config.buyer.address()) : config.buyer.address(),
    sellerAccount: sel.payTo,
    ...(chainByNetwork(sel.network) && sel.owner ? { sellerOwner: sel.owner } : {}),
    amount: sel.amount,
    asset: sel.asset,
    network: sel.network,
    txHash: settle.transaction,
    explorerUrl: explorerTx(sel.network, settle.transaction),
  });
  return { data, receipt, sellerVerified: sel.verified };
}

/** x402 puts the reason for a rejected payment in the PAYMENT-REQUIRED header (base64 JSON), not the body. */
function explain402(res: Response, data: unknown): string {
  // A failed verify puts the reason in PAYMENT-REQUIRED; a failed settlement puts it in PAYMENT-RESPONSE.
  let reason = "";
  for (const h of ["PAYMENT-REQUIRED", "X-PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"]) {
    const raw = res.headers.get(h);
    if (!raw || reason) continue;
    try {
      const j = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
      reason = [j.error || j.errorReason || j.invalidReason, j.errorMessage && j.errorMessage !== (j.errorReason || j.error) ? j.errorMessage : ""].filter(Boolean).join(": ");
    } catch { /* not base64 JSON */ }
  }
  const body = data && typeof data === "object" && Object.keys(data as object).length ? JSON.stringify(data) : "";
  const hint: Record<string, string> = {
    insufficient_funds: "the ProcureBot account doesn't have enough test CCD — top it up from the testnet faucet",
    preflight_insufficient_funds: "the ProcureBot account doesn't have enough test CCD — top it up from the testnet faucet",
    preflight_insufficient_token_funds: "the ProcureBot account doesn't hold enough of the invoice's stablecoin — top it up from the token issuer",
    preflight_missing_token_balance: "the ProcureBot account doesn't hold this stablecoin at all — get some from the token issuer first",
    token_decimals_lookup_failed: "the token doesn't exist on this network — check INVOICE_ASSET in .env (run npm run doctor)",
    insufficient_balance: "ProcureBot's Base / Solana wallet doesn't hold enough EURC — get test EURC from faucet.circle.com (run npm run doctor)",
    invalid_exact_evm_payload_signature: "the EURC signature was rejected — check EURC_BASE_EIP712_NAME / _VERSION (npm run doctor reads them from the token)",
    invalid_exact_svm_payload_transaction: "the Solana transfer was rejected — make sure TenderScout's Solana address has received EURC once (it needs a EURC token account)",
  };
  const key = Object.keys(hint).find((k) => reason.includes(k));
  return [reason, key ? `(${hint[key]})` : "", body].filter(Boolean).join(" ") ||
    "payment rejected without a reason; check the seller and facilitator windows for the error";
}
