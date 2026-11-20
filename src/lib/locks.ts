/**
 * Payment locks: the five-step, human-supervised lifecycle for paying a supplier invoice.
 *
 *   create   owner opens a lock for one invoice                       → created
 *   fund     owner sets the amount aside against today's budget        → funded
 *   send     the AGENT checks the payee's badge + every owner rule     → sent (awaiting release)
 *   release  a HUMAN approves; only now is the payment signed and settled on Concordium → released
 *   cancel   owner stops it at any point before release                → cancelled
 *
 * "Fund" reserves budget in Cord's records (it does not move money into an on-chain escrow);
 * money moves once, on release, as a sponsored x402 payment. Every operation, refusal and
 * outcome goes into the hash-chained audit log (src/lib/audit.ts).
 *
 * EU AI Act alignment: Art. 14 human oversight (release needs a person; pause stops the agent),
 * Art. 12 record-keeping (audit log + payment receipts), Art. 13/50 transparency (the agent's
 * checks and reasons are shown to the person deciding).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { audit, type Actor } from "./audit.js";
import { checkBadge } from "./badge.js";
import { loadPolicy, policyViolation } from "./policy.js";
import { atomicToEur } from "./eur.js";

export type LockStatus = "created" | "funded" | "sent" | "released" | "cancelled";
export interface LockEvent { op: string; at: string; actor: Actor; outcome: "ok" | "refused" | "error"; note: string }
export interface Lock {
  id: string;
  invoiceId: string;
  supplier: string;
  category: string;
  description: string;
  payTo: string;
  amountEur: number;
  amount: string; // atomic units settled on-chain (demo rate)
  asset: string;
  status: LockStatus;
  createdAt: string;
  updatedAt: string;
  checks?: { at: string; badgeVerified: boolean; badgeIssues: string[]; policy: string | null };
  txHash?: string;
  explorerUrl?: string;
  receiptSeq?: number;
  lastError?: string;
  history: LockEvent[];
}
export interface InvoiceRef { id: string; supplier: string; category: string; description: string; payTo: string; amountEur: number; amount: string; asset: string; status?: string }

export class LockError extends Error {
  constructor(message: string, public refused = true) { super(message); }
}

const locksPath = () => process.env.LOCKS_PATH || (process.env.VERCEL ? "/tmp/locks.json" : "data/locks.json");

export function readLocks(): Lock[] {
  const p = locksPath();
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return []; }
}
function writeLocks(all: Lock[]) {
  const p = locksPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(all, null, 2) + "\n");
}
function getLock(id: string): Lock {
  const l = readLocks().find((x) => x.id === id);
  if (!l) throw new LockError(`unknown lock ${id}`);
  return l;
}
function saveLock(lock: Lock) {
  const all = readLocks();
  const i = all.findIndex((x) => x.id === lock.id);
  if (i >= 0) all[i] = lock; else all.push(lock);
  writeLocks(all);
}
function record(lock: Lock, op: string, actor: Actor, outcome: LockEvent["outcome"], note: string, data?: Record<string, unknown>) {
  const at = new Date().toISOString();
  lock.history.push({ op, at, actor, outcome, note });
  lock.updatedAt = at;
  audit({ actor, op, lockId: lock.id, outcome, detail: note, data: { invoiceId: lock.invoiceId, amountEur: lock.amountEur, status: lock.status, ...data } });
}
const refuse = (lock: Lock, op: string, actor: Actor, reason: string): never => {
  lock.lastError = reason;
  record(lock, op, actor, "refused", reason);
  saveLock(lock);
  throw new LockError(reason);
};
const requireStatus = (lock: Lock, op: string, allowed: LockStatus[]) => {
  if (!allowed.includes(lock.status)) throw new LockError(`can't ${op} a lock that is ${lock.status} (needs ${allowed.join(" or ")})`);
};

/** EUR set aside by other funded/sent locks (so funding can't over-commit the daily limit). */
export function reservedEur(exceptId?: string): number {
  return readLocks()
    .filter((l) => (l.status === "funded" || l.status === "sent") && l.id !== exceptId)
    .reduce((s, l) => s + l.amountEur, 0);
}

// ---------------- the five operations ----------------

export function createLock(inv: InvoiceRef, actor: Actor = "owner"): Lock {
  if (inv.status === "paid") throw new LockError(`invoice ${inv.id} is already paid`);
  const open = readLocks().find((l) => l.invoiceId === inv.id && l.status !== "cancelled");
  if (open) throw new LockError(`invoice ${inv.id} already has lock ${open.id} (${open.status})`);
  const now = new Date().toISOString();
  const lock: Lock = {
    id: `LCK-${randomBytes(3).toString("hex").toUpperCase()}`,
    invoiceId: inv.id, supplier: inv.supplier, category: inv.category, description: inv.description,
    payTo: inv.payTo, amountEur: inv.amountEur, amount: inv.amount, asset: inv.asset,
    status: "created", createdAt: now, updatedAt: now, history: [],
  };
  record(lock, "create", actor, "ok", `Lock opened for ${inv.id} (${inv.supplier}), €${inv.amountEur.toLocaleString()}`);
  saveLock(lock);
  return lock;
}

export function fundLock(id: string, actor: Actor = "owner"): Lock {
  const lock = getLock(id);
  requireStatus(lock, "fund", ["created"]);
  const reason = policyViolation(loadPolicy(), lock.payTo, lock.amount, lock.asset, reservedEur(lock.id));
  if (reason) refuse(lock, "fund", actor, reason);
  lock.status = "funded";
  lock.lastError = undefined;
  record(lock, "fund", actor, "ok", `€${lock.amountEur.toLocaleString()} set aside against today's budget`);
  saveLock(lock);
  return lock;
}

export async function sendLock(id: string, release: (lock: Lock) => Promise<Lock>): Promise<Lock> {
  const lock = getLock(id);
  requireStatus(lock, "send", ["funded"]);
  const policy = loadPolicy();
  const reason = policyViolation(policy, lock.payTo, lock.amount, lock.asset, reservedEur(lock.id));
  const badge = await checkBadge(lock.payTo);
  lock.checks = { at: new Date().toISOString(), badgeVerified: badge.verified, badgeIssues: badge.issues, policy: reason ?? null };
  if (reason) refuse(lock, "send", "agent", reason);
  if (policy.requireSellerBadge && !badge.verified) refuse(lock, "send", "agent", `payee has no valid Verified by Concordium agent: ${badge.issues.join("; ")}`);
  lock.status = "sent";
  lock.lastError = undefined;
  record(lock, "send", "agent", "ok",
    `Checks passed: payee ${badge.verified ? "Verified by Concordium" : "not verified (allowed by policy)"}, within limits. ${policy.requireHumanRelease ? "Awaiting human release." : "Auto-release allowed by policy."}`,
    { badgeVerified: badge.verified });
  saveLock(lock);
  return policy.requireHumanRelease ? lock : release(lock);
}

export async function releaseLock(
  id: string,
  actor: Actor,
  pay: (lock: Lock, reservedOtherEur: number) => Promise<{ txHash?: string; explorerUrl?: string; receiptSeq?: number }>,
): Promise<Lock> {
  const lock = getLock(id);
  requireStatus(lock, "release", ["sent"]);
  const policy = loadPolicy();
  if (policy.paused) refuse(lock, "release", actor, "the agent is paused by the owner");
  if (policy.requireHumanRelease && actor !== "owner") refuse(lock, "release", actor, "policy requires a human to release payments");
  try {
    const r = await pay(lock, reservedEur(lock.id));
    lock.status = "released";
    lock.txHash = r.txHash;
    lock.explorerUrl = r.explorerUrl;
    lock.receiptSeq = r.receiptSeq;
    lock.lastError = undefined;
    record(lock, "release", actor, "ok", `Released by ${actor}: €${lock.amountEur.toLocaleString()} settled on Concordium (fee sponsored)`, { txHash: r.txHash });
    saveLock(lock);
    return lock;
  } catch (e) {
    const msg = (e as Error).message;
    lock.lastError = msg;
    record(lock, "release", actor, (e as { refused?: boolean }).refused || /refused/i.test(msg) ? "refused" : "error", msg);
    saveLock(lock);
    throw new LockError(msg, /refused/i.test(msg));
  }
}

export function cancelLock(id: string, actor: Actor = "owner", note = ""): Lock {
  const lock = getLock(id);
  requireStatus(lock, "cancel", ["created", "funded", "sent"]);
  const freed = lock.status === "funded" || lock.status === "sent";
  lock.status = "cancelled";
  record(lock, "cancel", actor, "ok", `Cancelled${note ? `: ${note}` : ""}${freed ? `; €${lock.amountEur.toLocaleString()} returned to today's budget` : ""}`);
  saveLock(lock);
  return lock;
}

export const lockTotals = () => {
  const all = readLocks();
  const by = (s: LockStatus) => all.filter((l) => l.status === s);
  return {
    count: all.length,
    awaitingRelease: by("sent").length,
    reservedEur: reservedEur(),
    releasedEur: by("released").reduce((s, l) => s + l.amountEur, 0),
    releasedAtomic: by("released").reduce((s, l) => s + BigInt(l.amount), 0n).toString(),
  };
};
export { atomicToEur };
