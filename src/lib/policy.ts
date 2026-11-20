/**
 * Owner spending policy for the purchasing agent (amounts in demo EUR). The owner sets these
 * rules on the owner page (or in data/policy.json); ProcureBot checks every one of them after
 * the supplier quotes a price and BEFORE anything is signed.
 *
 *   maxPerLockEur      cap per single lock / payment          (default €10,000)
 *   dailyLimitEur      cap on everything released today        (default €10,000; 0 = no cap)
 *   allowedAssets      assets the agent may settle in
 *   requireSellerBadge payee must own an Active, Verified by Concordium agent
 *   approvedSuppliers  if non-empty, the agent may only pay these accounts
 *   requireHumanRelease invoice payments need a human to press Release (EU AI Act Art. 14)
 *   requireOwnerSignature  that release must be signed by the agent owner's Concordium wallet
 *   paused             stop switch: the agent refuses every payment while paused (Art. 14(4)(e))
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { config } from "./config.js";
import { readReceipts } from "./receipts.js";
import { atomicToEur } from "./eur.js";

const eur = z.number().min(0).max(1_000_000_000);

export const PolicySchema = z.object({
  maxPerLockEur: eur,
  dailyLimitEur: eur,
  allowedAssets: z.array(z.string().min(1)).min(1),
  requireSellerBadge: z.boolean(),
  approvedSuppliers: z.array(z.object({ account: z.string().min(40), name: z.string().default("") })),
  requireHumanRelease: z.boolean().default(true),
  requireOwnerSignature: z.boolean().default(true),
  paused: z.boolean().default(false),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
});
export type Policy = z.infer<typeof PolicySchema>;

const policyPath = () => process.env.POLICY_PATH || (process.env.VERCEL ? "/tmp/policy.json" : "data/policy.json");

export function defaultPolicy(): Policy {
  return {
    maxPerLockEur: Number(process.env.MAX_PER_LOCK_EUR || 10_000),
    dailyLimitEur: Number(process.env.DAILY_LIMIT_EUR || 10_000),
    allowedAssets: config.buyer.allowedAssets,
    requireSellerBadge: config.buyer.requireSellerBadge,
    approvedSuppliers: [],
    requireHumanRelease: true,
    requireOwnerSignature: process.env.REQUIRE_OWNER_SIGNATURE !== "false",
    paused: false,
  };
}

export function loadPolicy(): Policy {
  const p = policyPath();
  if (!existsSync(p)) return defaultPolicy();
  try {
    return PolicySchema.parse(JSON.parse(readFileSync(p, "utf8")));
  } catch (e) {
    console.warn(`[policy] ${p} is invalid or from an older version, using defaults: ${(e as Error).message}`);
    return defaultPolicy();
  }
}

export function savePolicy(input: unknown, by = "owner"): Policy {
  const policy = { ...PolicySchema.parse(input), updatedAt: new Date().toISOString(), updatedBy: by };
  const p = policyPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(policy, null, 2) + "\n");
  return policy;
}

/** EUR the buyer has paid today (UTC), from its own receipts. */
export function spentTodayEur(): number {
  const today = new Date().toISOString().slice(0, 10);
  const atomic = readReceipts()
    .filter((r) => r.role === "buyer" && r.ts.startsWith(today))
    .reduce((sum, r) => sum + BigInt(r.amount), 0n);
  return atomicToEur(atomic);
}

/**
 * Checks that need no network. `reservedEur` is budget already set aside by other funded/sent
 * locks today, so funding can't over-commit the daily limit. Returns a reason if refused.
 */
export function policyViolation(p: Policy, payTo: string, amountAtomic: string, asset: string, reservedEur = 0): string | undefined {
  if (p.paused) return "the agent is paused by the owner";
  const amountEur = atomicToEur(amountAtomic);
  if (!p.allowedAssets.includes(asset)) return `asset ${asset} is not allowed (allowed: ${p.allowedAssets.join(", ")})`;
  if (p.maxPerLockEur > 0 && amountEur > p.maxPerLockEur) return `€${amountEur.toLocaleString()} is over the per-payment limit of €${p.maxPerLockEur.toLocaleString()}`;
  if (p.dailyLimitEur > 0) {
    const committed = spentTodayEur() + reservedEur;
    if (committed + amountEur > p.dailyLimitEur)
      return `daily limit reached: €${committed.toLocaleString()} already paid or set aside today, limit €${p.dailyLimitEur.toLocaleString()}`;
  }
  if (p.approvedSuppliers.length && !p.approvedSuppliers.some((s) => s.account === payTo)) return `payee ${payTo} is not on the approved supplier list`;
  return undefined;
}
