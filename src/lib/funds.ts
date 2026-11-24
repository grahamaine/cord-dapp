/**
 * Before a Base / Solana release: make sure the payment can actually go through, so a release that would only
 * fail on the network (e.g. Solana's "transaction simulation failed") is refused up front in plain words.
 *
 *   - ProcureBot holds enough EURC on that chain
 *   - Solana only: TenderScout already has a EURC account (a payee without one can't receive)
 *
 * Network trouble while checking never blocks a release: the payment itself still decides.
 */
import { privateKeyToAccount } from "viem/accounts";
import { base58 } from "@scure/base";
import { XCHAINS, buyerXKey, chainByNetwork } from "./chains.js";
import { fmtAtomic } from "./eur.js";
import type { Lock } from "./locks.js";

async function rpc(url: string, method: string, params: unknown[]) {
  const r: any = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(8_000) })).json();
  if (r.error) throw new Error(r.error.message);
  return r.result;
}

const FAUCET = "faucet.circle.com";

/** A plain-words reason the release can't work, or null if it can (or couldn't be checked). */
export async function fundsProblem(lock: Lock): Promise<string | null> {
  const x = chainByNetwork(lock.network);
  if (!x) return null; // Concordium: the facilitator and ProcureBot's CCD are checked by the payment itself
  const need = BigInt(lock.amount);
  try {
    if (x.family === "evm") {
      const key = buyerXKey.base();
      if (!key) return "ProcureBot has no Base wallet yet: run npm run wallets.";
      const addr = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`).address;
      const data = "0x70a08231" + addr.slice(2).toLowerCase().padStart(64, "0");
      const bal = BigInt(await rpc(XCHAINS.base.rpcUrl, "eth_call", [{ to: XCHAINS.base.token, data }, "latest"]));
      if (bal < need) return `ProcureBot holds ${fmtAtomic(bal, "EURC")} on Base Sepolia but this payment needs ${fmtAtomic(need, "EURC")}. Get EURC at ${FAUCET} (Base Sepolia) for ${addr}, then press Release again.`;
      return null;
    }
    const secret = buyerXKey.solana();
    if (!secret) return "ProcureBot has no Solana wallet yet: run npm run wallets.";
    const bytes = secret.startsWith("[") ? Uint8Array.from(JSON.parse(secret)) : base58.decode(secret);
    const buyer = base58.encode(bytes.slice(32, 64));
    const accounts = async (owner: string) => {
      const r = await rpc(XCHAINS.solana.rpcUrl, "getTokenAccountsByOwner", [owner, { mint: XCHAINS.solana.token }, { encoding: "jsonParsed" }]);
      return { n: r.value.length as number, amount: r.value.reduce((t: bigint, a: any) => t + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n) as bigint };
    };
    const [b, s] = await Promise.all([accounts(buyer), accounts(lock.payTo)]);
    if (b.amount < need) return `ProcureBot holds ${fmtAtomic(b.amount, "EURC")} on Solana devnet but this payment needs ${fmtAtomic(need, "EURC")}. If Circle's faucet (${FAUCET}, Solana Devnet) won't deliver, run npm run solana:token on the owner's computer, restart, then press Release again.`;
    if (s.n === 0) return `The supplier's Solana address ${lock.payTo} has no EURC account yet, so it can't receive. Run npm run solana:token on the owner's computer (it creates it), restart, then press Release again.`;
    return null;
  } catch {
    return null; // couldn't check (RPC busy/unreachable): let the payment decide
  }
}
