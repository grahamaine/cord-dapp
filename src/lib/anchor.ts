/**
 * Anchor the audit trail on Concordium. Writes the head hashes of the audit log and the payment
 * receipt chain into a RegisterData transaction, sent from the purchasing agent's owner account.
 * Anyone can later prove the records weren't rewritten: recompute the log, find the entry with
 * the anchored sequence number, and compare its hash with the one stored on-chain (visible on
 * CCDExplorer). Supports EU AI Act Art. 12 (record-keeping) with an external, tamper-evident timestamp.
 *
 * On-chain data (UTF-8, < 256 bytes):
 *   cord:audit:v1|a=<auditSeq>:<auditHash>|r=<receiptSeq>:<receiptHash>
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { credentials } from "@grpc/grpc-js";
import {
  AccountAddress, AccountTransactionType, DataBlob, TransactionExpiry, TransactionHash, buildBasicAccountSigner, signTransaction,
  type AccountTransaction,
} from "@concordium/web-sdk";
import { ConcordiumGRPCNodeClient } from "@concordium/web-sdk/nodejs";
import { getExplorerTxUrl } from "@x402/concordium";
import { config } from "./config.js";
import { readAudit, verifyAudit, audit } from "./audit.js";
import { readReceipts, verifyChain } from "./receipts.js";

export interface Anchor {
  at: string;
  auditSeq: number;
  auditHash: string;
  receiptSeq: number;
  receiptHash: string;
  data: string;
  txHash: string;
  explorerUrl: string;
  sender: string;
  finalized: boolean;
}

const anchorsPath = () => process.env.ANCHORS_PATH || (process.env.VERCEL ? "/tmp/anchors.jsonl" : "data/anchors.jsonl");
let client: ConcordiumGRPCNodeClient | undefined;
const grpc = () => (client ??= new ConcordiumGRPCNodeClient(config.grpc.host, config.grpc.port, credentials.createSsl(), { timeout: 20_000 }));

export function readAnchors(): Anchor[] {
  const p = anchorsPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** The string that goes on-chain for the current heads. */
export function anchorData() {
  const a = readAudit().at(-1);
  const r = readReceipts().at(-1);
  const data = `cord:audit:v1|a=${a?.seq ?? 0}:${a?.hash ?? "0"}|r=${r?.seq ?? 0}:${r?.hash ?? "0"}`;
  return { data, auditSeq: a?.seq ?? 0, auditHash: a?.hash ?? "", receiptSeq: r?.seq ?? 0, receiptHash: r?.hash ?? "" };
}

/** Build, sign and submit the RegisterData transaction; wait for finality. */
export async function anchorNow(): Promise<Anchor> {
  const auditOk = verifyAudit(), receiptsOk = verifyChain();
  if (!auditOk.ok) throw new Error(`audit log is broken at #${auditOk.brokenAt}; fix before anchoring`);
  if (!receiptsOk.ok) throw new Error(`receipt chain is broken at #${receiptsOk.brokenAt}; fix before anchoring`);
  const head = anchorData();
  if (!head.auditSeq) throw new Error("nothing to anchor yet");
  const last = readAnchors().at(-1);
  if (last && last.auditSeq === head.auditSeq && last.receiptSeq === head.receiptSeq) throw new Error("already anchored: nothing new since the last anchor");

  const sender = AccountAddress.fromBase58(config.buyer.address());
  const signer = buildBasicAccountSigner(config.buyer.privateKey());
  const nonce = (await grpc().getNextAccountNonce(sender)).nonce;
  const tx: AccountTransaction = {
    type: AccountTransactionType.RegisterData,
    header: { sender, nonce, expiry: TransactionExpiry.futureMinutes(5) },
    payload: { data: new DataBlob(new TextEncoder().encode(head.data).buffer as ArrayBuffer) },
  };
  const signature = await signTransaction(tx, signer);
  const hash = await grpc().sendAccountTransaction(tx, signature);
  const txHash = TransactionHash.toHexString(hash);
  let finalized = false;
  try {
    const outcome = await grpc().waitForTransactionFinalization(hash, 60_000);
    finalized = true;
    const summary: any = outcome.summary;
    if (summary?.type === "accountTransaction" && summary?.transactionType === "failed") throw new Error(`anchor rejected: ${JSON.stringify(summary.rejectReason)}`);
  } catch (e) {
    if (finalized) throw e; // rejected on-chain
  }
  const anchor: Anchor = { at: new Date().toISOString(), ...head, txHash, explorerUrl: getExplorerTxUrl(config.network, txHash) ?? "", sender: config.buyer.address(), finalized };
  const p = anchorsPath();
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(anchor) + "\n");
  audit({ actor: "owner", op: "anchor", outcome: "ok", detail: `Audit trail anchored on Concordium at #${head.auditSeq} (receipts #${head.receiptSeq})`, data: { txHash } });
  return anchor;
}

/** For each anchor: does the local log still contain the exact entry that was anchored? */
export function checkAnchors() {
  const auditBySeq = new Map(readAudit().map((e) => [e.seq, e.hash]));
  const receiptBySeq = new Map(readReceipts().map((r) => [r.seq, r.hash]));
  return readAnchors().map((a) => ({
    ...a,
    auditMatches: !a.auditSeq || auditBySeq.get(a.auditSeq) === a.auditHash,
    receiptsMatch: !a.receiptSeq || receiptBySeq.get(a.receiptSeq) === a.receiptHash,
  }));
}
