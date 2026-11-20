/**
 * Owner wallet approval for Release. Before a lock is released, the server issues a one-time
 * challenge describing exactly what will be paid; the owner signs it with their Concordium
 * wallet (browser extension or mobile via WalletConnect). The server checks the signature
 * against the account's on-chain keys and that the account is an authorised owner.
 * This ties every release to a specific, identity-verified human (EU AI Act Art. 14).
 */
import { randomBytes } from "node:crypto";
import { credentials } from "@grpc/grpc-js";
import { AccountAddress, verifyMessageSignature, type AccountTransactionSignature } from "@concordium/web-sdk";
import { ConcordiumGRPCNodeClient } from "@concordium/web-sdk/nodejs";
import { config } from "./config.js";

const TTL_MS = 5 * 60_000;
const challenges = new Map<string, { lockId: string; message: string; expires: number }>();

/** Accounts allowed to approve releases: OWNER_ACCOUNTS (comma separated), else the buyer agent's owner. */
export function ownerAccounts(): string[] {
  const list = (process.env.OWNER_ACCOUNTS || process.env.BUYER_OWNER || process.env.CCD_ADDRESS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return [...new Set(list)];
}

export function createChallenge(lock: { id: string; invoiceId: string; supplier: string; amountEur: number; payTo: string }) {
  const nonce = randomBytes(12).toString("hex");
  const expires = Date.now() + TTL_MS;
  const message = [
    "Kakasa · release approval",
    `Lock: ${lock.id}`,
    `Invoice: ${lock.invoiceId}`,
    `Supplier: ${lock.supplier}`,
    `Amount: EUR ${lock.amountEur.toLocaleString("en-IE")} (demo)`,
    `Payee: ${lock.payTo}`,
    `Network: ${config.registry.network}`,
    `Nonce: ${nonce}`,
    `Expires: ${new Date(expires).toISOString()}`,
    "I approve this payment prepared by an AI agent.",
  ].join("\n");
  for (const [k, v] of challenges) if (v.expires < Date.now()) challenges.delete(k);
  challenges.set(nonce, { lockId: lock.id, message, expires });
  return { nonce, message, expiresAt: new Date(expires).toISOString() };
}

let client: ConcordiumGRPCNodeClient | undefined;
const grpc = () => (client ??= new ConcordiumGRPCNodeClient(config.grpc.host, config.grpc.port, credentials.createSsl(), { timeout: 15_000 }));

/** Normalise wallet output: the extension returns {0:{0:hex}}; WalletConnect may return a JSON string or {signature}. */
function toSignature(sig: unknown): AccountTransactionSignature {
  let s: any = sig;
  if (typeof s === "string") s = JSON.parse(s);
  if (s && typeof s === "object" && "signature" in s) s = typeof s.signature === "string" ? JSON.parse(s.signature) : s.signature;
  if (!s || typeof s !== "object") throw new Error("unrecognised signature format");
  return s as AccountTransactionSignature;
}

/** Verify a signed challenge. Returns the approval record or throws with a clear reason. */
export async function verifyApproval(lockId: string, input: { nonce?: string; account?: string; signature?: unknown }) {
  if (!input.nonce || !input.signature) throw new Error("this release must be signed with the owner's Concordium wallet");
  const c = challenges.get(input.nonce);
  challenges.delete(input.nonce); // one attempt per challenge, whatever the outcome
  if (!c || c.lockId !== lockId) throw new Error("approval expired or already used; sign again");
  if (c.expires < Date.now()) throw new Error("approval expired; sign again");
  const account = String(input.account ?? "");
  if (!ownerAccounts().includes(account)) throw new Error(`wallet ${account || "(none)"} is not an authorised owner of this agent`);
  const signature = toSignature(input.signature);
  const info = await grpc().getAccountInfo(AccountAddress.fromBase58(account));
  const ok = await verifyMessageSignature(c.message, signature, info);
  if (!ok) throw new Error("wallet signature is not valid for this approval");
  return { account, nonce: input.nonce!, message: c.message, signature, at: new Date().toISOString() };
}

/** Test helper: verify against a provided account info (no network). */
export async function verifyWithInfo(message: string, signature: unknown, info: Parameters<typeof verifyMessageSignature>[2]) {
  return verifyMessageSignature(message, toSignature(signature), info);
}
