/**
 * Owner spending policy for the buyer agent. The business owner sets these rules on the
 * owner page (or by editing data/policy.json); ProcureBot checks every one of them after
 * the seller quotes a price and BEFORE anything is signed.
 *
 *   maxPayment         hard cap per single payment (atomic units)
 *   dailyLimit         cap on the total paid today, across all payees (atomic units, "0" = no cap)
 *   allowedAssets      assets the agent may pay in
 *   requireSellerBadge payee must own an Active, Verified by Concordium agent
 *   approvedSuppliers  if non-empty, the agent may only pay these accounts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { config } from "./config.js";
import { readReceipts } from "./receipts.js";

const atomic = z.string().regex(/^\d+$/, "must be a whole number of atomic units");

export const PolicySchema = z.object({
  maxPayment: atomic,
  dailyLimit: atomic,
  allowedAssets: z.array(z.string().min(1)).min(1),
  requireSellerBadge: z.boolean(),
  approvedSuppliers: z.array(z.object({ account: z.string().min(40), name: z.string().default("") })),
  updatedAt: z.string().optional(),
});
export type Policy = z.infer<typeof PolicySchema>;

const policyPath = () => process.env.POLICY_PATH || (process.env.VERCEL ? "/tmp/policy.json" : "data/policy.json");

export function defaultPolicy(): Policy {
  return {
    maxPayment: config.buyer.maxPayment.toString(),
    dailyLimit: process.env.DAILY_LIMIT || "0",
    allowedAssets: config.buyer.allowedAssets,
    requireSellerBadge: config.buyer.requireSellerBadge,
    approvedSuppliers: [],
  };
}

export function loadPolicy(): Policy {
  const p = policyPath();
  if (!existsSync(p)) return defaultPolicy();
  try {
    return PolicySchema.parse(JSON.parse(readFileSync(p, "utf8")));
  } catch (e) {
    console.warn(`[policy] ${p} is invalid, using defaults: ${(e as Error).message}`);
    return defaultPolicy();
  }
}

export function savePolicy(input: unknown): Policy {
  const policy = { ...PolicySchema.parse(input), updatedAt: new Date().toISOString() };
  const p = policyPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(policy, null, 2) + "\n");
  return policy;
}

/** Total the buyer has paid today (UTC), from its own receipts. */
export function spentToday(asset?: string): bigint {
  const today = new Date().toISOString().slice(0, 10);
  return readReceipts()
    .filter((r) => r.role === "buyer" && r.ts.startsWith(today) && (!asset || r.asset === asset))
    .reduce((sum, r) => sum + BigInt(r.amount), 0n);
}

/** Policy checks that don't need the network. Returns a reason string if the payment must be refused. */
export function policyViolation(p: Policy, payTo: string, amount: string, asset: string): string | undefined {
  const amt = BigInt(amount);
  if (!p.allowedAssets.includes(asset)) return `asset ${asset} is not allowed (allowed: ${p.allowedAssets.join(", ")})`;
  if (amt > BigInt(p.maxPayment)) return `amount ${amount} exceeds the per-payment limit ${p.maxPayment}`;
  const daily = BigInt(p.dailyLimit);
  if (daily > 0n) {
    const spent = spentToday(asset);
    if (spent + amt > daily) return `daily limit reached: ${spent} already paid today, limit ${daily}`;
  }
  if (p.approvedSuppliers.length && !p.approvedSuppliers.some((s) => s.account === payTo)) {
    return `payee ${payTo} is not on the approved supplier list`;
  }
  return undefined;
}
