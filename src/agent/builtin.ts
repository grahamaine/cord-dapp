/**
 * Built-in ProcureBot assistant: understands short instructions with simple rules and calls the
 * same tools as the Claude brain. No API key, no cost, runs entirely on the owner's machine.
 *
 *   "what's due?"                 → list_invoices
 *   "pay the laundry invoice"     → prepare_payment
 *   "cancel LCK-1A2B3C wrong qty" → cancel_lock
 *   "budget" / "how much left"    → budget_status
 *   "find hospitality tenders"    → find_tenders
 *   "benchmark towels"            → price_benchmark
 *   "check 3wT8…" / "verify JyP9…"→ check_supplier
 *   "check solana <address>"      → check_cross_chain_supplier
 *   "audit" / "history"           → audit_summary
 */
import { toolByName, TENDER_SECTORS, matchBenchmarkItem } from "./tools.js";
import { CHAINS } from "../lib/xchain.js";

export interface AgentAction { tool: string; input: Record<string, unknown>; result: unknown }
export interface AgentReply { reply: string; actions: AgentAction[]; mode: "builtin" | "claude"; suggestions?: string[] }

const eur = (n: number) => `€${Number(n || 0).toLocaleString("en-IE", { maximumFractionDigits: 2 })}`;
const SUGGEST = ["What's due?", "Pay the laundry invoice", "How much budget is left?", "Find hospitality tenders", "Show the audit trail"];

async function call(actions: AgentAction[], tool: string, input: Record<string, unknown>) {
  const t = toolByName(tool)!;
  const result: any = await t.run(input);
  actions.push({ tool, input, result });
  return result;
}

export async function builtinReply(message: string): Promise<AgentReply> {
  const m = message.trim();
  const q = m.toLowerCase();
  const actions: AgentAction[] = [];
  const done = (reply: string, suggestions = SUGGEST) => ({ reply, actions, mode: "builtin" as const, suggestions });

  // release is deliberately not something the agent can do
  if (/\brelease|approve|send the money|pay now|transfer\b/.test(q) && !/prepare/.test(q)) {
    return done("I can't release payments — that's your decision. Open **Locks**, check the agent's findings, and press **Release**; your wallet will ask you to sign. I can **prepare** a payment for you, though: try \"pay the laundry invoice\".");
  }

  // cancel LCK-XXXX reason
  const lockId = m.match(/LCK-[0-9A-F]{6}/i)?.[0]?.toUpperCase();
  if (/\bcancel|stop|void\b/.test(q) && lockId) {
    const reason = m.replace(/.*LCK-[0-9A-F]{6}/i, "").replace(/^[\s,:-]*(because|as|reason)?/i, "").trim() || "cancelled from agent chat";
    const r = await call(actions, "cancel_lock", { lock_id: lockId, reason });
    return done(r.done ? `Cancelled **${lockId}**. Any amount set aside is back in today's budget.` : `I couldn't cancel ${lockId}: ${r.reason}`);
  }

  // cross-chain check
  const chain = CHAINS.find((c) => q.includes(c.name.toLowerCase()) || (c.family === "solana" && /\bsolana\b/.test(q)) || (c.family === "evm" && /\b(base|ethereum|evm|eth)\b/.test(q) && c.id === "eip155:84532"));
  const longToken = m.split(/\s+/).find((w) => w.length >= 32);
  if (chain && longToken && /check|verify|supplier|agent/.test(q)) {
    const input = chain.family === "solana" ? { namespace: chain.id, address: longToken } : { namespace: chain.id, public_key_hex: longToken };
    const r = await call(actions, "check_cross_chain_supplier", input);
    return done(r.summary ?? `I couldn't check that ${chain.name} key: ${r.reason}`);
  }

  // Concordium account / badge check
  if (/\b(check|verify|verified|badge)\b/.test(q) && longToken) {
    const r = await call(actions, "check_supplier", { account_or_badge: longToken });
    return done(r.verified ? `✅ **Verified by Concordium** — ${r.agents} valid agent${r.agents === 1 ? "" : "s"}.` : `⚠️ Not verified: ${r.issues.join("; ")}`);
  }

  // budget
  if (/budget|limit|left|spent|remaining|how much/.test(q)) {
    const r = await call(actions, "budget_status", {});
    return done(`Today: **${eur(r.releasedTodayEur)}** released, **${eur(r.setAsideEur)}** set aside by open locks. ${r.dailyLimitEur ? `Daily limit ${eur(r.dailyLimitEur)} — **${eur(r.remainingEur)} left**.` : "No daily limit."} Max per payment ${eur(r.maxPerLockEur)}.${r.paused ? " ⏸ The agent is **paused**." : ""}`);
  }

  // tenders
  if (/tender/.test(q)) {
    const alias: Record<string, string> = { hotel: "hospitality", catering: "hospitality", linen: "hospitality", laundry: "hospitality", produce: "food", restaurant: "food", wifi: "it", "wi-fi": "it", computer: "it", tech: "it", ict: "it", medical: "health", hospital: "health", road: "construction", building: "construction", guard: "security", vehicle: "transport", fuel: "transport", school: "education" };
    const sector = TENDER_SECTORS.find((s) => new RegExp(`\\b${s}\\b`).test(q)) ?? Object.entries(alias).find(([k]) => q.includes(k))?.[1];
    if (!sector) return done(`Which sector? I have tender lists for: ${TENDER_SECTORS.join(", ")}.`, TENDER_SECTORS.map((s) => `Find ${s} tenders`));
    const r = await call(actions, "find_tenders", { sector, purpose: `Agent chat: "${m}"` });
    if (r.done === false || !r.data) return done(`I couldn't buy the tender list: ${r.reason ?? "no data"}`);
    const items = (r.data.items ?? r.data.tenders ?? []).slice(0, 5);
    return done(`Bought the **${sector}** tender list${r.receipt ? ` (receipt #${r.receipt.seq}, fee sponsored)` : ""}:\n${items.map((t: any) => `• ${t.title} — ${t.entity}, closes ${t.closes} ${t.estimate ? ` (est. ${t.currency} ${Number(t.estimate).toLocaleString()})` : ""}`).join("\n") || "No open tenders in that sector right now."}${r.data.live ? `\n_Live from Uganda's Government Procurement Portal (PPDA open data), fetched ${String(r.data.fetchedAt).slice(0, 10)}._` : ""}`);
  }

  // benchmark
  if (/benchmark|price of|prices? for|how much (do|does|should)/.test(q)) {
    const item = matchBenchmarkItem(q);
    if (!item) return done("Which item? I have benchmarks for bath towels, double bed sheets, rice (25kg) and cooking oil (20l).", ["Benchmark bath towels", "Benchmark rice"]);
    const r = await call(actions, "price_benchmark", { item, purpose: `Agent chat: "${m}"` });
    if (r.done === false || !r.data) return done(`I couldn't buy the benchmark: ${r.reason ?? "no data"}`);
    const d = r.data;
    const n = (v: number) => Number(v).toLocaleString();
    return done(`Price benchmark for **${d.item}** (per ${d.unit}, ${d.samples} quotes): low ${d.currency} ${n(d.low)} · median ${d.currency} ${n(d.median)} · high ${d.currency} ${n(d.high)}.`);
  }

  // prepare payment
  if (/\b(pay|prepare|settle|clear)\b/.test(q)) {
    const target = q.replace(/\b(please|can you|could you|pay|prepare|settle|clear|the|a|an|invoice|bill|payment|for|to|our|my)\b/g, " ").trim();
    if (!target) return done("Which invoice? Say e.g. \"pay the laundry invoice\" or \"pay INV-SEC-1130\".");
    const r = await call(actions, "prepare_payment", { invoice: target });
    if (r.done) {
      const l = r.lock;
      if (!r.steps.length) return done(`**${l.id}** for ${l.supplier} (${eur(l.amountEur)}) is already prepared and ${l.awaitingRelease ? "**awaiting your release** — open **Locks** and press **Release**." : `is ${l.status}.`}`, ["Show my locks", "What's due?"]);
      return done(`Prepared **${l.id}** for ${l.supplier}: **${eur(l.amountEur)}** (${l.invoiceId})${l.fullValue ? `, paid as **${l.settles}**` : ""}.\n✔ ${r.steps.join(" · ")}\n${l.checks?.badgeVerified ? "✔ Supplier is Verified by Concordium" : "⚠ Supplier not verified (allowed by your policy)"}\n\n👉 **Your turn:** open **Locks** and press **Release** — your wallet will ask you to sign.`, ["Show my locks", "How much budget is left?", "What's due?"]);
    }
    if (r.candidates?.length > 1) return done(`More than one invoice matches — which one?\n${r.candidates.map((c: string) => `• ${c}`).join("\n")}`);
    const tip = r.lock && r.lock.status === "created" ? `\nLock **${r.lock.id}** is on hold. You can raise the limit in **Policy**, or say "cancel ${r.lock.id}" to drop it.` : "";
    return done(`⛔ I didn't prepare it: ${r.reason}.${tip}`, r.lock ? [`Cancel ${r.lock.id}`, "What's due?"] : SUGGEST);
  }

  // locks
  if (/\block|awaiting|pending|waiting/.test(q)) {
    const r = await call(actions, "list_locks", {});
    const open = r.locks.filter((l: any) => l.status !== "cancelled" && l.status !== "released");
    return done(open.length ? `Open locks:\n${open.map((l: any) => `• **${l.id}** ${l.supplier} ${eur(l.amountEur)} — ${l.status === "sent" ? "awaiting your release" : l.status}`).join("\n")}` : "No open locks. Say \"pay the … invoice\" to prepare one.");
  }

  // invoices / due
  if (/due|invoice|owe|bill|open|outstanding|unpaid/.test(q)) {
    const r = await call(actions, "list_invoices", { only_open: true });
    return done(r.invoices.length ? `**${r.invoices.length} unpaid invoices**, ${eur(r.openTotalEur)} in total:\n${r.invoices.map((i: any) => `• ${i.id} ${i.supplier} — ${eur(i.amountEur)}, due ${i.due}${i.lock ? ` · lock ${i.lock.id} (${i.lock.status === "sent" ? "awaiting release" : i.lock.status})` : ""}`).join("\n")}` : "Nothing unpaid. 🎉");
  }

  // audit
  if (/audit|history|log|trail|record/.test(q)) {
    const r = await call(actions, "audit_summary", { last: 6 });
    return done(`Audit log ${r.auditLog.ok ? `intact (${r.auditLog.count} entries)` : `**BROKEN at #${r.auditLog.brokenAt}**`}, receipts ${r.receipts.ok ? `intact (${r.receipts.count})` : `**BROKEN at #${r.receipts.brokenAt}**`}. Latest:\n${r.recent.map((e: any) => `• #${e.seq} ${e.who === "agent" ? "AI agent" : e.who} · ${e.op} · ${e.outcome} — ${e.detail}`).join("\n")}`);
  }

  return done("I'm ProcureBot, your purchasing agent. I can list what's due, **prepare** payments (you release them), check suppliers — including on other blockchains — check the budget, buy tender lists and price benchmarks, and summarise the audit trail. Try one of these:");
}
