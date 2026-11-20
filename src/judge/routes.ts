/**
 * Judge view (read-only, public): cord-dapp.vercel.app/judge
 *   GET /judge            page
 *   GET /api/judge        the published snapshot + independent checks:
 *     1. the audit log and receipt hash chains recompute correctly from the snapshot itself
 *     2. every anchor transaction is finalized on Concordium and carries exactly the anchored heads
 *     3. every payment in the receipts is a finalized, successful transaction on Concordium
 *
 * The snapshot is published from the owner's computer with `npm run publish:judge`. No keys are
 * needed or stored here, and nothing in this route can move money.
 */
import { Router } from "express";
import { existsSync, readFileSync } from "node:fs";
import { credentials } from "@grpc/grpc-js";
import { ConcordiumGRPCNodeClient } from "@concordium/web-sdk/nodejs";
import { TransactionHash } from "@concordium/web-sdk";
import { getExplorerTxUrl } from "@x402/concordium";
import { config } from "../lib/config.js";
import { verifyAuditEntries, type AuditEntry } from "../lib/audit.js";
import { verifyReceiptEntries, type Receipt } from "../lib/receipts.js";
import type { Anchor } from "../lib/anchor.js";
import type { Lock } from "../lib/locks.js";

const APP_NAME = process.env.APP_NAME || "Cord";
const SNAPSHOT = "judge/snapshot.json";
const PAGE = "src/judge/index.html";

interface Snapshot {
  publishedAt: string; network: string;
  accounts: Record<string, string>; badges: Record<string, string>;
  policy: Record<string, unknown>;
  locks: Lock[]; audit: AuditEntry[]; receipts: Receipt[]; anchors: Anchor[];
}

let client: ConcordiumGRPCNodeClient | undefined;
const grpc = () => (client ??= new ConcordiumGRPCNodeClient(config.grpc.host, config.grpc.port, credentials.createSsl(), { timeout: 15_000 }));
const toJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

/** Look a transaction up on Concordium: finalized? succeeded? (+ the raw summary as text, for data checks) */
async function onChain(txHash: string) {
  const st: any = await grpc().getBlockItemStatus(TransactionHash.fromHexString(txHash));
  if (st.status !== "finalized") return { finalized: false, success: false, text: "" };
  const summary = st.outcome?.summary;
  const failed = summary?.transactionType === "failed" || summary?.type === "failed" || /"rejectReason"/.test(toJson(summary));
  return { finalized: true, success: !failed, text: toJson(summary).toLowerCase(), blockHash: String(st.outcome?.blockHash ?? "") };
}

let cache: { at: number; body: unknown } | undefined;
async function build() {
  if (!existsSync(SNAPSHOT)) return { published: false };
  const s: Snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  const auditCheck = verifyAuditEntries(s.audit);
  const receiptCheck = verifyReceiptEntries(s.receipts);
  const auditBySeq = new Map(s.audit.map((e) => [e.seq, e.hash]));
  const receiptBySeq = new Map(s.receipts.map((r) => [r.seq, r.hash]));
  let nodeReachable = true;

  const anchors = await Promise.all(s.anchors.map(async (a) => {
    const inSnapshot = (!a.auditSeq || auditBySeq.get(a.auditSeq) === a.auditHash) && (!a.receiptSeq || receiptBySeq.get(a.receiptSeq) === a.receiptHash);
    const dataHex = Buffer.from(a.data, "utf8").toString("hex");
    try {
      const tx = await onChain(a.txHash);
      return { ...a, inSnapshot, onChain: tx.finalized && tx.success, dataOnChainMatches: tx.text.includes(dataHex), explorerUrl: a.explorerUrl || getExplorerTxUrl(s.network as any, a.txHash) };
    } catch (e) {
      nodeReachable = false;
      return { ...a, inSnapshot, onChain: null, dataOnChainMatches: null, error: (e as Error).message };
    }
  }));

  const payments = await Promise.all(s.receipts.filter((r) => r.role === "buyer" && r.txHash).map(async (r) => {
    try {
      const tx = await onChain(r.txHash!);
      return { seq: r.seq, ts: r.ts, purpose: r.purpose, resource: r.resource, amount: r.amount, asset: r.asset, to: r.sellerAccount, txHash: r.txHash, explorerUrl: r.explorerUrl, onChain: tx.finalized && tx.success };
    } catch (e) {
      nodeReachable = false;
      return { seq: r.seq, ts: r.ts, purpose: r.purpose, resource: r.resource, amount: r.amount, asset: r.asset, to: r.sellerAccount, txHash: r.txHash, explorerUrl: r.explorerUrl, onChain: null };
    }
  }));

  const lastAnchor = anchors.at(-1);
  // covered = anchored in this snapshot and not contradicted by the chain (unchecked counts while the node is unreachable)
  const anchoredUpTo = anchors.filter((a) => a.inSnapshot && a.onChain !== false && a.dataOnChainMatches !== false).reduce((m, a) => Math.max(m, a.auditSeq), 0);
  return {
    published: true,
    publishedAt: s.publishedAt, network: s.network, accounts: s.accounts, badges: s.badges, policy: s.policy,
    checks: {
      auditChain: auditCheck, receiptChain: receiptCheck, nodeReachable,
      anchoredUpTo, auditCount: s.audit.length,
      allAnchorsVerified: anchors.length > 0 && anchors.every((a) => a.inSnapshot && a.onChain && a.dataOnChainMatches),
      allPaymentsOnChain: payments.every((p) => p.onChain),
      lastAnchorAt: lastAnchor?.at ?? null,
    },
    anchors, payments,
    locks: s.locks.map((l) => ({ id: l.id, invoiceId: l.invoiceId, supplier: l.supplier, category: l.category, description: l.description, amountEur: l.amountEur, status: l.status, checks: l.checks, approval: l.approval ? { account: l.approval.account } : null, txHash: l.txHash, explorerUrl: l.explorerUrl, history: l.history })).reverse(),
    audit: [...s.audit].reverse(),
  };
}

export function judgeRouter() {
  const r = Router();
  r.get("/judge", (_req, res) => {
    const html = existsSync(PAGE) ? readFileSync(PAGE, "utf8") : readFileSync(new URL("./index.html", import.meta.url), "utf8");
    res.type("html").send(html.replaceAll("{{APP_NAME}}", APP_NAME));
  });
  r.get("/api/judge", async (_req, res) => {
    try {
      if (!cache || Date.now() - cache.at > 60_000) cache = { at: Date.now(), body: await build() };
      res.set("cache-control", "public, max-age=30").json(cache.body);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
  return r;
}
