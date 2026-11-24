/**
 * Settlement chains. Concordium is the home chain (CCD or a PLT stablecoin, fees sponsored by Kakasa's
 * own facilitator). Suppliers whose agents live on Base or Solana can be paid there, in Circle's
 * euro stablecoin EURC, through x402 `exact` — but only if their key is linked to an identity-verified
 * Concordium owner through the CIS-8 registry (see src/lib/payee.ts).
 *
 *   XCHAIN_FACILITATOR_URL   x402 facilitator for Base/Solana (default: the free public testnet one,
 *                            https://x402.org/facilitator, which also pays the network fees)
 *   EURC_BASE / EURC_SOLANA  EURC token on Base Sepolia / mint on Solana devnet (Circle testnet defaults)
 *   ASSET_EUR_EURC           EUR value of 1 EURC in this demo. Default 1000: EUR 1,000 settles as 1 EURC,
 *                            so the 10 EURC a day from Circle's faucet covers several invoices.
 */
import "dotenv/config";
import { getExplorerTxUrl } from "@x402/concordium";
import { config } from "./config.js";

export type ChainKey = "concordium" | "base" | "solana";

export interface XChain {
  key: Exclude<ChainKey, "concordium">;
  name: string;
  network: `${string}:${string}`;
  family: "evm" | "solana";
  /** Symbol used in policies, receipts and limits. */
  asset: "EURC";
  /** On-chain token: ERC-20 contract (Base) or SPL mint (Solana). */
  token: string;
  decimals: number;
  rpcUrl: string;
  /** EIP-712 domain of the token, needed for EIP-3009 transferWithAuthorization (EVM only). */
  eip712?: { name: string; version: string };
  explorerTx: (tx: string) => string;
  explorerAddress: (a: string) => string;
}

const env = (k: string, d: string) => process.env[k] || d;

export const XCHAIN_FACILITATOR_URL = env("XCHAIN_FACILITATOR_URL", "https://x402.org/facilitator");

export const XCHAINS: Record<"base" | "solana", XChain> = {
  base: {
    key: "base",
    name: "Base Sepolia",
    network: "eip155:84532",
    family: "evm",
    asset: "EURC",
    token: env("EURC_BASE", "0x808456652fdb597867f38412077A9182bf77359F"),
    decimals: 6,
    rpcUrl: env("BASE_RPC_URL", "https://sepolia.base.org"),
    eip712: { name: env("EURC_BASE_EIP712_NAME", "EURC"), version: env("EURC_BASE_EIP712_VERSION", "2") },
    explorerTx: (tx) => `https://sepolia.basescan.org/tx/${tx}`,
    explorerAddress: (a) => `https://sepolia.basescan.org/address/${a}`,
  },
  solana: {
    key: "solana",
    name: "Solana devnet",
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    family: "solana",
    asset: "EURC",
    token: env("EURC_SOLANA", "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr"),
    decimals: 6,
    rpcUrl: env("SOLANA_RPC_URL", "https://api.devnet.solana.com"),
    explorerTx: (tx) => `https://explorer.solana.com/tx/${tx}?cluster=devnet`,
    explorerAddress: (a) => `https://explorer.solana.com/address/${a}?cluster=devnet`,
  },
};

export const chainName = (key: ChainKey | undefined) => (!key || key === "concordium" ? "Concordium" : XCHAINS[key].name);

export function chainByNetwork(network: string | undefined): XChain | undefined {
  return Object.values(XCHAINS).find((c) => c.network === network);
}

export function networkOf(key: ChainKey | undefined): string {
  return !key || key === "concordium" ? config.network : XCHAINS[key].network;
}

export function chainKeyOf(network: string | undefined): ChainKey {
  return chainByNetwork(network)?.key ?? "concordium";
}

/** Explorer link for a transaction on whichever chain it settled on. */
export function explorerTx(network: string | undefined, tx: string): string {
  const x = chainByNetwork(network);
  return x ? x.explorerTx(tx) : (getExplorerTxUrl((network || config.network) as any, tx) ?? "");
}

/** Map an x402 requirement's asset (token address / mint) back to the symbol the owner's policy uses. */
export function assetSymbol(network: string, asset: string): string {
  const x = chainByNetwork(network);
  return x && x.token.toLowerCase() === asset.toLowerCase() ? x.asset : asset;
}

/** URL path that pays an invoice on its settlement chain. */
export const invoicePayPath = (id: string, chain: ChainKey = "concordium") =>
  `/invoices/${encodeURIComponent(id)}/pay${chain === "concordium" ? "" : `/${chain}`}`;

/** Seller (TenderScout) receiving addresses on other chains, from .env. Empty = chain not offered. */
export const sellerXAddress = {
  base: () => process.env.SELLER_EVM_ADDRESS?.trim() || "",
  solana: () => process.env.SELLER_SOLANA_ADDRESS?.trim() || "",
};
/** The EVM public key behind SELLER_EVM_ADDRESS: an address alone can't be looked up in CIS-8. */
export const sellerEvmPublicKey = () => process.env.SELLER_EVM_PUBLIC_KEY?.trim() || "";

/** Buyer (ProcureBot) keys on other chains, from .env. */
export const buyerXKey = {
  base: () => process.env.BUYER_EVM_PRIVATE_KEY?.trim() || "",
  solana: () => process.env.BUYER_SOLANA_SECRET_KEY?.trim() || "",
};

/**
 * Is a transaction final and successful on Base Sepolia / Solana devnet? Plain JSON-RPC over fetch,
 * so it also runs on Vercel for the judge view.
 */
export async function xchainTxStatus(network: string, tx: string): Promise<{ finalized: boolean; success: boolean }> {
  const x = chainByNetwork(network);
  if (!x) throw new Error(`not an external chain: ${network}`);
  const rpc = async (method: string, params: unknown[]) => {
    const res = await fetch(x.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    const j: any = await res.json();
    if (j.error) throw new Error(`${x.name} RPC: ${j.error.message}`);
    return j.result;
  };
  if (x.family === "evm") {
    const r = await rpc("eth_getTransactionReceipt", [tx]);
    return r ? { finalized: true, success: r.status === "0x1" } : { finalized: false, success: false };
  }
  const r = await rpc("getSignatureStatuses", [[tx], { searchTransactionHistory: true }]);
  const st = r?.value?.[0];
  if (!st) return { finalized: false, success: false };
  return { finalized: st.confirmationStatus === "finalized", success: st.err === null };
}

/**
 * Kakasa's Base and Solana settlement is testnet-only (Base Sepolia, Solana devnet). A mainnet RPC address in .env
 * makes every balance, check and payment go to the wrong network, so say so loudly.
 */
export function rpcProblems(): string[] {
  const out: string[] = [];
  if (/mainnet/i.test(XCHAINS.base.rpcUrl) && !/sepolia/i.test(XCHAINS.base.rpcUrl))
    out.push(`BASE_RPC_URL points to Base mainnet (${XCHAINS.base.rpcUrl.replace(/\/v2\/.*/, "/v2/…")}). Use a Base Sepolia address, e.g. https://sepolia.base.org`);
  if (/mainnet/i.test(XCHAINS.solana.rpcUrl))
    out.push(`SOLANA_RPC_URL points to Solana mainnet (${XCHAINS.solana.rpcUrl.replace(/\/v2\/.*/, "/v2/…")}). Use a devnet address, e.g. https://api.devnet.solana.com (or solana-devnet.g.alchemy.com for Alchemy)`);
  return out;
}
