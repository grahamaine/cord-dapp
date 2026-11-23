/**
 * Judge demo mode. With JUDGE_PASSWORD set (next to DASHBOARD_PASSWORD), judges sign in to the owner dashboard
 * with their own password and can run the whole flow themselves, including Release, without the owner's wallet:
 *
 *   - testnet only, and only on judge demo invoices (ids starting DEMO-), never the owner's own invoices
 *   - capped: JUDGE_MAX_PER_LOCK_EUR per release (default €2,000) and JUDGE_DAILY_LIMIT_EUR per day (default €5,000),
 *     on top of every owner limit, badge check and pause switch
 *   - the release is recorded as "judge" in the hash-chained audit log, clearly marked as a demo approval
 *     (a judge session, not an owner wallet signature)
 *   - owner-only actions stay closed: policy, pause/resume, anchoring, CIS-8 key links
 */
import { randomBytes } from "node:crypto";
import { CONCORDIUM_TESTNET_CAIP2 } from "@x402/concordium";
import { config } from "./config.js";
import { readLocks, LockError, type Lock } from "./locks.js";

export const judgeLimits = () => ({
  perLockEur: Number(process.env.JUDGE_MAX_PER_LOCK_EUR || 2_000),
  dailyEur: Number(process.env.JUDGE_DAILY_LIMIT_EUR || 5_000),
});
export const isDemoInvoice = (invoiceId: string) => invoiceId.startsWith("DEMO-");

/** EUR released by judges today (UTC). */
export function judgeReleasedTodayEur(): number {
  const today = new Date().toISOString().slice(0, 10);
  return readLocks()
    .filter((l) => l.status === "released" && l.approval?.method === "judge" && l.updatedAt.startsWith(today))
    .reduce((s, l) => s + l.amountEur, 0);
}

/** Checks a judge may open a lock on this invoice. */
export function assertJudgeInvoice(invoiceId: string) {
  if (!isDemoInvoice(invoiceId)) throw new LockError("judges work on judge demo invoices: press “New demo invoice” on the Locks tab");
}

/** The approval record for a judge release, or a clear refusal. */
export function judgeApproval(lock: Lock): NonNullable<Lock["approval"]> {
  if (config.network !== CONCORDIUM_TESTNET_CAIP2) throw new Error("judge demo mode only works on testnet");
  assertJudgeInvoice(lock.invoiceId);
  const { perLockEur, dailyEur } = judgeLimits();
  if (lock.amountEur > perLockEur) throw new Error(`judge demo releases are capped at €${perLockEur.toLocaleString()} per payment`);
  const today = judgeReleasedTodayEur();
  if (today + lock.amountEur > dailyEur) throw new Error(`judge demo daily cap reached: €${today.toLocaleString()} released by judges today, cap €${dailyEur.toLocaleString()}`);
  const at = new Date().toISOString();
  return {
    account: "judge-demo",
    method: "judge",
    at,
    nonce: randomBytes(12).toString("hex"),
    message: `Kakasa · judge demo approval\nLock: ${lock.id}\nInvoice: ${lock.invoiceId}\nAmount: EUR ${lock.amountEur} (demo)\nApproved by a signed-in judge at ${at} (no owner wallet signature).`,
    signature: null,
  };
}
