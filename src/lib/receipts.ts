/**
 * Append-only, hash-chained receipt log. Each paid agent-to-agent call records who paid whom
 * (badges + accounts), for what, how much, and the finalized Concordium transaction hash.
 * Editing or deleting any line breaks the chain, which `npm run audit:verify` detects.
 * This supports EU AI Act Article 12-style record keeping: automatic, tamper-evident logs
 * that trace each action back to an accountable, identity-verified owner.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

export interface ReceiptInput {
  role: "buyer" | "seller";
  resource: string;
  buyerAccount?: string;
  buyerBadge?: string;
  sellerAccount: string;
  sellerBadge?: string;
  amount: string;
  asset: string;
  network: string;
  txHash?: string;
  explorerUrl?: string;
  purpose?: string; // the task / human instruction that led to this purchase
}
export interface Receipt extends ReceiptInput {
  seq: number;
  ts: string;
  prevHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);
const digest = (r: Omit<Receipt, "hash">) => createHash("sha256").update(JSON.stringify(r)).digest("hex");

export function readReceipts(path = config.receiptsPath): Receipt[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function appendReceipt(input: ReceiptInput, path = config.receiptsPath): Receipt {
  mkdirSync(dirname(path), { recursive: true });
  const all = readReceipts(path);
  const last = all.at(-1);
  const base = { ...input, seq: (last?.seq ?? 0) + 1, ts: new Date().toISOString(), prevHash: last?.hash ?? GENESIS };
  const receipt: Receipt = { ...base, hash: digest(base) };
  appendFileSync(path, JSON.stringify(receipt) + "\n");
  return receipt;
}

export function verifyChain(path = config.receiptsPath): { ok: boolean; count: number; brokenAt?: number } {
  return verifyReceiptEntries(readReceipts(path));
}

/** Check a list of receipts (e.g. a published snapshot) without touching the file. */
export function verifyReceiptEntries(all: Receipt[]): { ok: boolean; count: number; brokenAt?: number } {
  let prev = GENESIS;
  for (const r of all) {
    const { hash, ...rest } = r;
    if (r.prevHash !== prev || digest(rest) !== hash) return { ok: false, count: all.length, brokenAt: r.seq };
    prev = hash;
  }
  return { ok: true, count: all.length };
}
