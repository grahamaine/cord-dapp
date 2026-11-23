/**
 * ProcureBot's tools — one definition shared by every "brain":
 *   - the built-in assistant in the owner dashboard (no API key, no cost)
 *   - the optional Claude brain (only if ANTHROPIC_API_KEY is set)
 *   - the MCP server, so Claude Desktop (normal Claude plan) can drive the agent
 *
 * The agent can look things up and PREPARE payments (create → fund → send a lock). It has no
 * release tool: only a person can release, signed with the owner's wallet (EU AI Act Art. 14).
 * State-changing tools are recorded in the audit log as actions by the AI agent.
 */
import { config } from "../lib/config.js";
import { checkBadge } from "../lib/badge.js";
import { loadPolicy, spentTodayEur } from "../lib/policy.js";
import { readAudit, verifyAudit } from "../lib/audit.js";
import { readReceipts, verifyChain } from "../lib/receipts.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { isDemoInvoice } from "../lib/judge.js";
import { cancelLock, createLock, fundLock, readLocks, reservedEur, sendLock, LockError, type Lock } from "../lib/locks.js";
import { verifyCrossChain, CHAINS } from "../lib/xchain.js";
import { buy } from "../buyer/procurebot.js";
import { benchmarks } from "../seller/data.js";
import { TENDER_SECTORS as ALL_SECTORS } from "../lib/tenders.js";
import { fmtAtomic, isCcd } from "../lib/eur.js";

/** Map free text to a known benchmark item BEFORE paying (the price is charged before lookup). */
export function matchBenchmarkItem(text: string) {
  const q = text.toLowerCase();
  const keys = Object.keys(benchmarks);
  return keys.find((k) => k === q) ?? keys.find((k) => k.split(/[^a-z]+/).filter((w) => w.length > 2).some((w) => q.includes(w.replace(/s$/, "")))) ?? null;
}
export const TENDER_SECTORS: string[] = [...ALL_SECTORS];

/** Who is chatting with the agent. In judge demo mode the agent only prepares and cancels judge demo invoices. */
export const agentContext = new AsyncLocalStorage<{ role: "owner" | "judge" }>();
const judging = () => agentContext.getStore()?.role === "judge";
const JUDGE_ONLY_DEMO = "In judge demo mode I only work on judge demo invoices (ids starting DEMO-). Press “New demo invoice” on the Locks tab, then ask me to pay it.";

export interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, any>; required?: string[] };
  run: (input: any) => Promise<unknown>;
}

const eur = (n: number) => `€${n.toLocaleString("en-IE", { maximumFractionDigits: 2 })}`;
const lockView = (l: Lock) => ({
  id: l.id, invoiceId: l.invoiceId, supplier: l.supplier, amountEur: l.amountEur, status: l.status,
  settles: fmtAtomic(l.amount, l.asset), fullValue: !isCcd(l.asset),
  awaitingRelease: l.status === "sent", checks: l.checks ?? null, lastError: l.lastError ?? null, txHash: l.txHash ?? null,
});

async function invoices() {
  const r = await fetch(`${config.seller.url}/invoices`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`supplier agent unreachable at ${config.seller.url} (is npm run seller running?)`);
  const body: any = await r.json();
  const locks = readLocks().filter((l) => l.status !== "cancelled");
  return (body.items as any[]).map((i) => {
    const l = locks.find((x) => x.invoiceId === i.id);
    return { ...i, payTo: i.payTo ?? body.payTo, asset: i.asset ?? body.asset, network: i.network, payPath: i.payPath, lock: l ? { id: l.id, status: l.status } : null };
  });
}

/** Match free text ("laundry", "INV-LAU-1107", "Lakeside") to one invoice. */
export async function findInvoice(query: string) {
  const all = (await invoices()).filter((i) => !judging() || isDemoInvoice(i.id));
  const q = query.toLowerCase().trim();
  const exact = all.find((i) => i.id.toLowerCase() === q);
  if (exact) return { match: exact, candidates: [exact] };
  const words = q.split(/[^a-z0-9-]+/).filter((w) => w.length > 2);
  const scored = all
    .map((i) => {
      const hay = `${i.id} ${i.supplier} ${i.category} ${i.description}`.toLowerCase();
      return { i, score: words.filter((w) => hay.includes(w)).length };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const top = scored.filter((x) => x.score === scored[0]?.score).map((x) => x.i);
  return { match: top.length === 1 ? top[0] : null, candidates: top };
}

export const TOOLS: ToolDef[] = [
  {
    name: "list_invoices",
    description: "List supplier invoices with amount (EUR), due date, whether paid, and any open payment lock.",
    input_schema: { type: "object", properties: { only_open: { type: "boolean", description: "only unpaid invoices without a released lock" } } },
    run: async ({ only_open }) => {
      const all = await invoices();
      const rows = all.filter((i) => !only_open || i.status !== "paid").map((i) => ({ id: i.id, supplier: i.supplier, category: i.category, description: i.description, due: i.due, amountEur: i.amountEur, status: i.status, lock: i.lock }));
      return { invoices: rows, openTotalEur: rows.filter((i) => i.status !== "paid").reduce((s, i) => s + i.amountEur, 0) };
    },
  },
  {
    name: "prepare_payment",
    description:
      "Prepare payment of one invoice: create a lock, set the amount aside, and run the agent's checks (supplier badge + owner limits). Stops at 'awaiting release' — a person must release it with the owner's wallet. Give an invoice id or words that identify it (supplier, category).",
    input_schema: { type: "object", properties: { invoice: { type: "string" } }, required: ["invoice"] },
    run: async ({ invoice }) => {
      const { match, candidates } = await findInvoice(String(invoice));
      if (judging() && !match && !candidates.length) return { done: false, reason: JUDGE_ONLY_DEMO, candidates: [] };
      if (!match) return { done: false, reason: candidates.length ? "more than one invoice matches; be more specific" : "no invoice matches", candidates: candidates.map((c) => `${c.id} ${c.supplier} ${eur(c.amountEur)}`) };
      if (match.status === "paid") return { done: false, reason: `${match.id} is already paid` };
      const steps: string[] = [];
      try {
        let lock = match.lock ? readLocks().find((l) => l.id === match.lock.id)! : null;
        if (!lock) { lock = createLock({ ...match }, "agent"); steps.push(`created ${lock.id}`); }
        if (lock.status === "created") { lock = fundLock(lock.id, "agent"); steps.push(`set aside ${eur(lock.amountEur)}`); }
        if (lock.status === "funded") {
          lock = await sendLock(lock.id, async (l) => l); // never auto-release from the agent
          steps.push("checks passed");
        }
        return { done: true, steps, lock: lockView(lock), next: lock.status === "sent" ? "Awaiting your release: open Locks and press Release (signed with your wallet)." : `Lock is ${lock.status}.` };
      } catch (e) {
        const lock = readLocks().find((l) => l.invoiceId === match.id && l.status !== "cancelled");
        return { done: false, steps, refused: e instanceof LockError ? e.refused : false, reason: (e as Error).message, lock: lock ? lockView(lock) : null };
      }
    },
  },
  {
    name: "list_locks",
    description: "List payment locks and their status (created, funded, awaiting release, released, cancelled).",
    input_schema: { type: "object", properties: { status: { type: "string", enum: ["created", "funded", "sent", "released", "cancelled"] } } },
    run: async ({ status }) => ({ locks: readLocks().filter((l) => !status || l.status === status).map(lockView).reverse() }),
  },
  {
    name: "cancel_lock",
    description: "Cancel a payment lock before it is released (frees the budget). Needs the lock id and a short reason.",
    input_schema: { type: "object", properties: { lock_id: { type: "string" }, reason: { type: "string" } }, required: ["lock_id", "reason"] },
    run: async ({ lock_id, reason }) => {
      const target = readLocks().find((l) => l.id === String(lock_id));
      if (judging() && target && !isDemoInvoice(target.invoiceId)) return { done: false, reason: JUDGE_ONLY_DEMO };
      try { return { done: true, lock: lockView(cancelLock(String(lock_id), "agent", String(reason))) }; }
      catch (e) { return { done: false, reason: (e as Error).message }; }
    },
  },
  {
    name: "budget_status",
    description: "Today's spending: released, set aside by open locks, the daily and per-lock limits, and whether the agent is paused.",
    input_schema: { type: "object", properties: {} },
    run: async () => {
      const p = loadPolicy(), spent = spentTodayEur(), reserved = reservedEur();
      return { releasedTodayEur: spent, setAsideEur: reserved, dailyLimitEur: p.dailyLimitEur, maxPerLockEur: p.maxPerLockEur, remainingEur: p.dailyLimitEur ? Math.max(0, p.dailyLimitEur - spent - reserved) : null, paused: p.paused, requireHumanRelease: p.requireHumanRelease, requireOwnerSignature: p.requireOwnerSignature };
    },
  },
  {
    name: "check_supplier",
    description: "Check whether a Concordium account or agent badge is Verified by Concordium.",
    input_schema: { type: "object", properties: { account_or_badge: { type: "string" } }, required: ["account_or_badge"] },
    run: async ({ account_or_badge }) => {
      const b = await checkBadge(String(account_or_badge));
      return { verified: b.verified, agents: b.agents, issues: b.issues };
    },
  },
  {
    name: "check_cross_chain_supplier",
    description: `Verify a supplier agent on another blockchain through its CIS-8 link to Concordium. Chains: ${CHAINS.map((c) => `${c.name}=${c.id}`).join(", ")}. Solana: give the address; EVM: give the public key.`,
    input_schema: { type: "object", properties: { namespace: { type: "string" }, address: { type: "string" }, public_key_hex: { type: "string" } }, required: ["namespace"] },
    run: async ({ namespace, address, public_key_hex }) => {
      try { return await verifyCrossChain({ namespace, address, publicKeyHex: public_key_hex }); }
      catch (e) { return { verified: false, reason: (e as Error).message }; }
    },
  },
  {
    name: "find_tenders",
    description: `Buy the current list of open public tenders for a sector from TenderScout (a small paid data purchase, within the owner's limits). Live from Uganda's Government Procurement Portal. Sectors: ${ALL_SECTORS.join(", ")}.`,
    input_schema: { type: "object", properties: { sector: { type: "string" }, purpose: { type: "string" } }, required: ["sector"] },
    run: async ({ sector, purpose }) => {
      if (!TENDER_SECTORS.includes(String(sector).toLowerCase())) return { done: false, reason: `unknown sector "${sector}"; available: ${TENDER_SECTORS.join(", ")}`, nothingPaid: true };
      try { return await buy(`${config.seller.url}/tenders?sector=${encodeURIComponent(String(sector))}`, String(purpose || `Agent chat: tenders for ${sector}`)); }
      catch (e) { return { done: false, reason: (e as Error).message }; }
    },
  },
  {
    name: "price_benchmark",
    description: "Buy a supplier price benchmark (low/median/high) for an item from TenderScout (a small paid data purchase, within the owner's limits).",
    input_schema: { type: "object", properties: { item: { type: "string" }, purpose: { type: "string" } }, required: ["item"] },
    run: async ({ item, purpose }) => {
      const known = matchBenchmarkItem(String(item));
      if (!known) return { done: false, reason: `no benchmark for "${item}"; available: ${Object.keys(benchmarks).join(", ")}`, nothingPaid: true };
      try { return await buy(`${config.seller.url}/price-benchmark?item=${encodeURIComponent(known)}`, String(purpose || `Agent chat: benchmark ${known}`)); }
      catch (e) { return { done: false, reason: (e as Error).message }; }
    },
  },
  {
    name: "audit_summary",
    description: "Summarise the audit trail: integrity of the audit log and receipts, and the most recent entries.",
    input_schema: { type: "object", properties: { last: { type: "number", description: "how many recent entries (default 8)" } } },
    run: async ({ last }) => ({
      auditLog: verifyAudit(), receipts: verifyChain(),
      recent: readAudit().slice(-(Number(last) || 8)).reverse().map((e) => ({ seq: e.seq, when: e.ts, who: e.actor, op: e.op, outcome: e.outcome, detail: e.detail })),
      payments: readReceipts().filter((r) => r.role === "buyer").length,
    }),
  },
];

export const toolByName = (name: string) => TOOLS.find((t) => t.name === name);
