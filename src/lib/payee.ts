/**
 * Who is behind a payee, on any settlement chain? The single accountability check used when a lock is
 * sent to the agent and again right before ProcureBot signs a payment.
 *
 *   Concordium      the payee account must own an Active, Verified by Concordium agent (badge check).
 *   Base / Solana   the payee's key must be linked through the CIS-8 external key registry to a Concordium
 *                   owner, with the binding Active, and that owner must be identity-verified: either the
 *                   agent that references the key carries a valid badge, or the owner account owns one.
 *
 * An EVM address doesn't reveal its public key, so for Base the seller publishes it at
 * /.well-known/payee-keys.json. That claim is self-checking: we only accept a key whose derived address
 * equals the payee address, then look the key up on Concordium.
 */
import { checkBadge } from "./badge.js";
import { config } from "./config.js";
import { chainByNetwork } from "./chains.js";
import { evmAddressOf, verifyCrossChain } from "./xchain.js";

export interface PayeeVerdict {
  verified: boolean;
  issues: string[];
  /** Concordium account accountable for the payee (the payee itself on Concordium). */
  owner: string | null;
  summary: string;
}

const cache = new Map<string, { at: number; v: PayeeVerdict }>();
const TTL_MS = 60_000;

let keysCache: { at: number; keys: Record<string, { address: string; publicKey?: string }> } | undefined;
/** Public keys the seller publishes for its non-Concordium receiving addresses. */
export async function sellerPayeeKeys(): Promise<Record<string, { address: string; publicKey?: string }>> {
  if (keysCache && Date.now() - keysCache.at < TTL_MS) return keysCache.keys;
  try {
    const res = await fetch(`${config.seller.url}/.well-known/payee-keys.json`, { signal: AbortSignal.timeout(10_000) });
    const keys = res.ok ? ((await res.json()) as any).keys ?? {} : {};
    keysCache = { at: Date.now(), keys };
    return keys;
  } catch {
    return {};
  }
}

export async function verifyPayee(network: string | undefined, payTo: string): Promise<PayeeVerdict> {
  const id = `${network}|${payTo}`;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;
  const v = await check(network, payTo);
  cache.set(id, { at: Date.now(), v });
  return v;
}

async function check(network: string | undefined, payTo: string): Promise<PayeeVerdict> {
  const x = chainByNetwork(network);
  if (!x) {
    const b = await checkBadge(payTo);
    return { verified: b.verified, issues: b.issues, owner: payTo, summary: b.verified ? "Verified by Concordium" : `not verified: ${b.issues.join("; ")}` };
  }

  let publicKeyHex: string | undefined;
  if (x.family === "evm") {
    const published = (await sellerPayeeKeys())[x.network];
    if (!published?.publicKey) {
      return { verified: false, issues: [`no public key published for ${payTo}`], owner: null, summary: `can't look up ${x.name} address ${payTo}: its public key isn't published` };
    }
    try {
      if (evmAddressOf(published.publicKey).toLowerCase() !== payTo.toLowerCase()) {
        return { verified: false, issues: ["published public key does not match the payee address"], owner: null, summary: "published key does not belong to the payee address" };
      }
    } catch {
      return { verified: false, issues: ["published public key is not a valid secp256k1 key"], owner: null, summary: "invalid published key" };
    }
    publicKeyHex = published.publicKey;
  }

  let r: Awaited<ReturnType<typeof verifyCrossChain>>;
  try {
    r = await verifyCrossChain({ namespace: x.network, address: payTo, publicKeyHex });
  } catch (e) {
    return { verified: false, issues: [(e as Error).message], owner: null, summary: `registry lookup failed: ${(e as Error).message}` };
  }
  if (r.verified) return { verified: true, issues: [], owner: r.concordiumOwner, summary: r.summary };

  // Key bound (Active) to a Concordium owner who already runs a Verified by Concordium agent.
  if (r.linked && r.keyStatus === "Active" && r.concordiumOwner) {
    const b = await checkBadge(r.concordiumOwner);
    if (b.verified) {
      return {
        verified: true,
        issues: [],
        owner: r.concordiumOwner,
        summary: `Verified: ${x.name} key linked through CIS-8 to Concordium account ${r.concordiumOwner}, which owns ${b.agents} Verified by Concordium agent${b.agents === 1 ? "" : "s"}.`,
      };
    }
    return { verified: false, issues: b.issues, owner: r.concordiumOwner, summary: `${x.name} key is linked, but its Concordium owner has no valid badge: ${b.issues.join("; ")}` };
  }
  return { verified: false, issues: [r.summary], owner: r.concordiumOwner, summary: r.summary };
}
