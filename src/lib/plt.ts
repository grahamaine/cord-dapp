/**
 * Protocol-Level Token (PLT) lookups: which stablecoins exist on the network, their decimals, and
 * what each account holds. Read-only; used by the dashboards and `npm run doctor`.
 */
import { credentials } from "@grpc/grpc-js";
import { ConcordiumGRPCNodeClient } from "@concordium/web-sdk/nodejs";
import { AccountAddress, TokenId } from "@concordium/web-sdk";
import { config } from "./config.js";

let client: ConcordiumGRPCNodeClient | undefined;
const grpc = () => (client ??= new ConcordiumGRPCNodeClient(config.grpc.host, config.grpc.port, credentials.createSsl(), { timeout: 15_000 }));

export interface TokenBalance { asset: string; amount: string; decimals: number }

/** Every PLT the account holds, as atomic amounts. */
export async function tokenBalances(address: string): Promise<TokenBalance[]> {
  const info: any = await grpc().getAccountInfo(AccountAddress.fromBase58(address));
  return (info.accountTokens ?? []).map((t: any) => ({
    asset: String(t.id),
    amount: BigInt(t.state.balance.value).toString(),
    decimals: Number(t.state.balance.decimals),
  }));
}

/** Decimals of a PLT on this network, or undefined if it doesn't exist. */
export async function tokenDecimals(asset: string): Promise<number | undefined> {
  try {
    const info: any = await grpc().getTokenInfo(TokenId.fromString(asset));
    return Number(info.state.decimals);
  } catch {
    return undefined;
  }
}

/** Symbols of all PLTs on this network. */
export async function tokenList(): Promise<string[]> {
  const out: string[] = [];
  for await (const id of grpc().getTokenList()) out.push(String(id));
  return out;
}
