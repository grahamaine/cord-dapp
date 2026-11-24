/**
 * Cord web: the owner's dashboard and control page.
 *   Dashboard  - service status, account balances + badges, payments with CCDExplorer links,
 *                and the tamper-evident receipt chain.
 *   Locks      - the five-step, human-supervised payment lifecycle for supplier invoices:
 *                create → fund → send (agent checks) → release (human; settles on-chain) | cancel.
 *   Policy     - per-lock and daily limits in demo EUR (€10,000 defaults), allowed assets,
 *                badge rule, approved suppliers, human release, and a pause switch.
 *   Audit      - hash-chained log of every operation (EU AI Act Art. 12 / 26(6)).
 *
 *   npm run web   ->  http://localhost:4030
 *
 * This server holds the buyer's signing key, so it listens on localhost only by default.
 * Do not expose it publicly without adding authentication.
 */
import express from "express";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getExplorerTxUrl } from "@x402/concordium";
import { config } from "../lib/config.js";
import { checkBadge, checkBadgeQuick } from "../lib/badge.js";
import { readReceipts, verifyChain, type Receipt } from "../lib/receipts.js";
import { loadPolicy, savePolicy, spentTodayEur } from "../lib/policy.js";
import { audit, readAudit, verifyAudit } from "../lib/audit.js";
import { createLock, fundLock, sendLock, releaseLock, cancelLock, readLocks, lockTotals, LockError, type Lock } from "../lib/locks.js";
import { atomicToEur, settlementInfo } from "../lib/eur.js";
import { tokenBalances } from "../lib/plt.js";
import { createChallenge, ownerAccounts, verifyApproval } from "../lib/approval.js";
import { CHAINS, verifyCrossChain } from "../lib/xchain.js";
import { chainByNetwork, explorerTx } from "../lib/chains.js";
import { verifyPayee, verifyPayeeQuick } from "../lib/payee.js";
import { fundsProblem } from "../lib/funds.js";
import { registryTool } from "../lib/registry-mcp.js";
import { anchorNow, anchorData, checkAnchors } from "../lib/anchor.js";
import { buy, PaymentRefused } from "../buyer/procurebot.js";
import { mountAssets } from "../ui/assets.js";
import { builtinReply } from "../agent/builtin.js";
import { mountAuth, authEnabled, judgeEnabled, judgeOpen, roleOf } from "./auth.js";
import { assertJudgeInvoice, isDemoInvoice, judgeApproval, judgeLimits, judgeReleasedTodayEur } from "../lib/judge.js";
import { agentContext } from "../agent/tools.js";
import { claudeEnabled, claudeReply } from "../agent/claude.js";

const APP_NAME = process.env.APP_NAME || "Kakasa";
const PORT = Number(process.env.WEB_PORT || 4030);
const HOST = process.env.WEB_HOST || "127.0.0.1";
const TESTNET = config.network === "ccd:4221332d34e1694168c2a0c0b3fd0f27";
const WALLET_PROXY = process.env.WALLET_PROXY || (TESTNET ? "https://wallet-proxy.testnet.concordium.com" : "https://wallet-proxy.mainnet.concordium.software");

const accounts = {
  buyer: process.env.CCD_ADDRESS || "",
  seller: process.env.SELLER_PAY_TO || "",
  facilitator: process.env.CCD_FACILITATOR_ADDRESS || "",
};

async function getJson(url: string, timeoutMs = 8000): Promise<{ ok: boolean; status: number; body: any }> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
  } catch (e) {
    return { ok: false, status: 0, body: { error: (e as Error).message } };
  }
}

/** One row per on-chain payment: buyer and seller receipts for the same tx are merged. */
function payments(receipts: Receipt[]) {
  const byTx = new Map<string, any>();
  for (const r of receipts) {
    const key = r.txHash || `seq-${r.seq}`;
    const row = byTx.get(key) ?? {
      txHash: r.txHash ?? null,
      explorerUrl: r.explorerUrl || (r.txHash ? explorerTx(r.network, r.txHash) : null),
      ts: r.ts,
      resource: r.resource,
      amount: r.amount,
      asset: r.asset,
      buyerAccount: r.buyerAccount ?? null,
      sellerAccount: r.sellerAccount,
      buyerBadge: r.buyerBadge ?? null,
      sellerBadge: r.sellerBadge ?? null,
      purpose: null as string | null,
      recordedBy: [] as string[],
      receipts: [] as { seq: number; role: string; hash: string }[],
    };
    row.recordedBy.push(r.role);
    row.receipts.push({ seq: r.seq, role: r.role, hash: r.hash });
    if (r.purpose) row.purpose = r.purpose;
    row.buyerAccount ??= r.buyerAccount ?? null;
    row.buyerBadge ??= r.buyerBadge ?? null;
    row.sellerBadge ??= r.sellerBadge ?? null;
    if (r.ts < row.ts) row.ts = r.ts;
    byTx.set(key, row);
  }
  return [...byTx.values()].sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

const app = express();
app.use(express.json({ limit: "100kb" }));
mountAuth(app, APP_NAME);
mountAssets(app);
// The Concordium SDK's prebuilt browser bundle, served from this PC (the CDN copy fails to load in some
// browsers). Used by the dashboard to send CIS-8 key links through the browser wallet.
app.get("/assets/concordium-sdk.js", (_req, res) =>
  res.type("application/javascript").set("cache-control", "public, max-age=86400").sendFile(join(process.cwd(), "node_modules/@concordium/web-sdk/lib/min/concordium.web.min.js")));

const page = () => readFileSync(new URL("./index.html", import.meta.url), "utf8").replaceAll("{{APP_NAME}}", APP_NAME);
app.get("/", (_req, res) => res.type("html").send(page()));

app.get("/api/overview", async (_req, res) => {
  const [facilitator, seller] = await Promise.all([
    getJson(`${config.facilitator.url}/healthz`, 4000),
    getJson(`${config.seller.url}/healthz`, 4000),
  ]);
  const receipts = readReceipts();
  const rows = payments(receipts);
  const policy = loadPolicy();
  res.json({
    app: APP_NAME,
    network: config.network,
    testnet: TESTNET,
    accounts,
    services: {
      facilitator: { url: config.facilitator.url, up: facilitator.ok, info: facilitator.body },
      seller: { url: config.seller.url, up: seller.ok, info: seller.body },
    },
    chain: verifyChain(),
    receiptCount: receipts.length,
    payments: rows,
    totals: {
      payments: rows.filter((r) => r.txHash).length,
      paidByAsset: rows.reduce<Record<string, string>>((acc, r) => {
        const a = r.asset || "CCD";
        acc[a] = (BigInt(acc[a] ?? "0") + BigInt(r.amount)).toString();
        return acc;
      }, {}),
      paidEur: Math.round(rows.reduce((s, r) => s + (atomicToEur(r.amount, r.asset || "CCD") || 0), 0) * 100) / 100,
      spentTodayEur: spentTodayEur(),
      dailyLimitEur: policy.dailyLimitEur,
      maxPerLockEur: policy.maxPerLockEur,
      ...lockTotals(),
    },
    policy: { paused: policy.paused, requireHumanRelease: policy.requireHumanRelease },
    audit: verifyAudit(),
    settlement: settlementInfo(),
  });
});

// Balances and badges change slowly: reuse the answer for 20 s (the page asks after every action).
let accountsCache: { at: number; body: unknown } | null = null;
app.get("/api/accounts", async (_req, res) => {
  if (accountsCache && Date.now() - accountsCache.at < 20_000) return res.json(accountsCache.body);
  const out = await Promise.all(
    Object.entries(accounts).map(async ([role, address]) => {
      if (!address) return { role, address, missing: true };
      const [bal, badge, tokens] = await Promise.all([
        getJson(`${WALLET_PROXY}/v0/accBalance/${address}`),
        role === "facilitator" ? Promise.resolve(null) : checkBadgeQuick(address),
        tokenBalances(address).catch(() => null),
      ]);
      const b = bal.body?.finalizedBalance ?? bal.body?.currentBalance;
      return {
        role,
        address,
        balance: b?.accountAmount ?? null,
        tokens, // PLT stablecoin balances, e.g. [{ asset: "EURR", amount, decimals }]
        balanceError: bal.ok ? null : `wallet proxy HTTP ${bal.status}`,
        badge: badge ? { verified: badge.verified, agents: badge.agents, issues: badge.issues } : null,
      };
    }),
  );
  accountsCache = { at: Date.now(), body: { accounts: out } };
  res.json({ accounts: out });
});

app.get("/api/receipts/raw", (_req, res) => res.json({ chain: verifyChain(), receipts: readReceipts() }));

app.get("/api/policy", (_req, res) => res.json(loadPolicy()));
app.put("/api/policy", (req, res) => {
  try {
    const before = loadPolicy();
    const saved = savePolicy(req.body);
    const changed = Object.keys(saved).filter((k) => !["updatedAt", "updatedBy"].includes(k) && JSON.stringify((saved as any)[k]) !== JSON.stringify((before as any)[k]));
    audit({ actor: "owner", op: "policy", outcome: "ok", detail: changed.length ? `Policy changed: ${changed.join(", ")}` : "Policy saved (no changes)", data: { maxPerLockEur: saved.maxPerLockEur, dailyLimitEur: saved.dailyLimitEur, requireSellerBadge: saved.requireSellerBadge, requireHumanRelease: saved.requireHumanRelease, approvedSuppliers: saved.approvedSuppliers.length } });
    res.json(saved);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// Stop switch (EU AI Act Art. 14(4)(e)): pause or resume the agent.
app.post("/api/agent/:action(pause|resume)", (req, res) => {
  const paused = req.params.action === "pause";
  const saved = savePolicy({ ...loadPolicy(), paused });
  audit({ actor: "owner", op: req.params.action, outcome: "ok", detail: paused ? "Agent paused: all payments refused until resumed" : "Agent resumed" });
  res.json(saved);
});

// Wallet connect settings for the owner page (no secrets here: the project id is public).
app.get("/api/session", (req, res) =>
  res.json({ auth: authEnabled() && !(judgeOpen() && roleOf(req) === "judge" && !/cord_session=/.test(String(req.headers.cookie || ""))), open: judgeOpen(), role: roleOf(req), judgeMode: judgeEnabled(), judge: judgeEnabled() ? { ...judgeLimits(), releasedTodayEur: judgeReleasedTodayEur() } : null }));

// ---- ProcureBot chat: built-in assistant (free) or Claude if ANTHROPIC_API_KEY is set. Never releases.
app.get("/api/agent/info", (_req, res) => res.json({ mode: claudeEnabled() ? "claude" : "builtin", name: "ProcureBot" }));
app.post("/api/agent/chat", async (req, res) => {
  const message = String(req.body?.message ?? "").slice(0, 2000).trim();
  if (!message) return res.status(400).json({ error: "empty message" });
  const history = (Array.isArray(req.body?.history) ? req.body.history : [])
    .filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string")
    .map((m: any) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  try {
    let out;
    out = await agentContext.run({ role: roleOf(req) }, async () => {
      if (!claudeEnabled()) return builtinReply(message);
      try { return await claudeReply([...history, { role: "user", content: message }]); }
      catch (e) { const o = await builtinReply(message); o.reply = `(Claude unavailable: ${(e as Error).message.slice(0, 120)} — using the built-in assistant)\n\n` + o.reply; return o; }
    });
    const READ_ONLY = new Set(["list_invoices", "list_locks", "budget_status", "audit_summary", "check_supplier", "check_cross_chain_supplier"]);
    if (out.actions.some((a) => !READ_ONLY.has(a.tool))) audit({ actor: "agent", op: "chat", outcome: "ok", detail: `${roleOf(req) === "judge" ? "Judge" : "Owner"} asked: "${message.slice(0, 120)}" → ${out.actions.map((a) => a.tool).join(", ")}`, data: { mode: out.mode } });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get("/api/wallet/config", (_req, res) =>
  res.json({
    network: config.registry.network,
    chainId: `ccd:${config.registry.network}`,
    walletConnectProjectId: process.env.WALLETCONNECT_PROJECT_ID || null,
    ownerAccounts: ownerAccounts(),
    requireOwnerSignature: loadPolicy().requireOwnerSignature,
  }),
);

// TenderScout's Base / Solana keys, prepared by `npm run link-keys`, waiting for the owner's wallet to send the
// CIS-8 register call. Each entry also says whether the key is linked on-chain yet.
app.get("/api/xchain/links", async (_req, res) => {
  const links = [];
  for (const chain of ["base", "solana"]) {
    const file = `data/cis8-link-${chain}.json`;
    if (!existsSync(file)) continue;
    const l = JSON.parse(readFileSync(file, "utf8"));
    const onChain = await registryTool("owner_of_key", { external_key: l.externalKey }).catch(() => null);
    links.push({ ...l, linked: onChain?.status === "Active", linkedOwner: onChain?.owner ?? null });
  }
  res.json({ links });
});
app.post("/api/xchain/links/:chain/sent", (req, res) => {
  const { txHash, account } = req.body ?? {};
  audit({ actor: "owner", op: "xchain-link", outcome: "ok", detail: `CIS-8 key link for TenderScout on ${req.params.chain} sent by ${account}: ${txHash}`, data: { chain: req.params.chain, txHash, account } });
  res.json({ ok: true, explorerUrl: txHash ? getExplorerTxUrl(config.network, txHash) : null });
});

// Cross-chain suppliers: verify an agent from another blockchain via its CIS-8 link to Concordium.
app.get("/api/xchain/chains", (_req, res) => res.json({ chains: CHAINS }));
app.post("/api/xchain/verify", async (req, res) => {
  try {
    const r = await verifyCrossChain(req.body ?? {});
    audit({ actor: "owner", op: "xchain-check", outcome: r.verified ? "ok" : "refused", detail: `${r.chain} ${r.address}: ${r.summary}`, data: { namespace: r.namespace, owner: r.concordiumOwner, agent: r.agent?.tokenId } });
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get("/api/audit", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 2000, 10_000);
  const anchors = checkAnchors();
  const last = anchors.at(-1);
  const head = anchorData();
  res.json({
    chain: verifyAudit(),
    receipts: verifyChain(),
    entries: readAudit().slice(-limit).reverse(),
    anchors: anchors.reverse(),
    head: { auditSeq: head.auditSeq, receiptSeq: head.receiptSeq },
    unanchored: head.auditSeq - (last?.auditSeq ?? 0),
  });
});

// Anchor the audit trail on Concordium (RegisterData tx from the agent owner's account).
app.post("/api/audit/anchor", async (_req, res) => {
  try {
    res.json({ ok: true, anchor: await anchorNow() });
  } catch (e) {
    audit({ actor: "owner", op: "anchor", outcome: "error", detail: (e as Error).message });
    res.status(409).json({ ok: false, error: (e as Error).message });
  }
});

// Full trail for one payment lock: its events, the agent's checks, the signed approval, the
// on-chain payment and both receipts.
app.get("/api/locks/:id/trail", (req, res) => {
  const lock = readLocks().find((l) => l.id === req.params.id);
  if (!lock) return res.status(404).json({ error: `unknown lock ${req.params.id}` });
  const events = readAudit().filter((e) => e.lockId === lock.id);
  const payPath = lock.payPath || `/invoices/${lock.invoiceId}/pay`;
  const receipts = readReceipts().filter((r) => (lock.txHash && r.txHash === lock.txHash) || r.resource.split("?")[0].endsWith(payPath));
  const lastSeq = Math.max(0, ...events.map((e) => e.seq));
  const anchoredBy = lastSeq ? checkAnchors().find((a) => a.auditSeq >= lastSeq) ?? null : null;
  res.json({ lock: withExplorer(lock), events, receipts, anchoredBy });
});

app.get("/api/invoices", async (_req, res) => {
  const r = await getJson(`${config.seller.url}/invoices`);
  if (!r.ok) return res.status(502).json({ error: `seller unreachable at ${config.seller.url}`, detail: r.body });
  // Screen only: answer fast from the last registry check (payments always check properly on Send).
  const badge = r.body.payTo ? await checkBadgeQuick(r.body.payTo) : null;
  const items = await Promise.all((r.body.items ?? []).map(async (i: any) => {
    const x = chainByNetwork(i.network);
    // Base / Solana payees: show whether their key is CIS-8 linked to a verified Concordium owner.
    const link = x && i.status !== "paid" ? await verifyPayeeQuick(i.network, i.payTo).catch(() => null) : null;
    return {
      ...i,
      chainName: x?.name ?? "Concordium",
      payeeLink: link ? { verified: link.verified, owner: link.owner, summary: link.summary } : null,
      paidExplorerUrl: i.paidTx ? explorerTx(i.paidNetwork ?? i.network, i.paidTx) : null,
    };
  }));
  res.json({ ...r.body, items, payeeBadge: badge ? { verified: badge.verified, agents: badge.agents, issues: badge.issues } : null });
});

// ---------------- payment locks: create → fund → send → release | cancel ----------------
async function invoiceRef(id: string) {
  const r = await getJson(`${config.seller.url}/invoices`);
  if (!r.ok) throw new LockError(`seller unreachable at ${config.seller.url}`, false);
  const i = (r.body.items ?? []).find((x: any) => x.id === id);
  if (!i) throw new LockError(`unknown invoice ${id}`);
  return { ...i, payTo: i.payTo ?? r.body.payTo, asset: i.asset ?? r.body.asset, network: i.network, payPath: i.payPath };
}
const withExplorer = (l: Lock) => ({ ...l, chainName: chainByNetwork(l.network)?.name ?? "Concordium", explorerUrl: l.explorerUrl || (l.txHash ? explorerTx(l.network, l.txHash) : undefined) });

/** Release = the only place money moves: a sponsored x402 payment through ProcureBot. */
async function payLock(lock: Lock, reservedOtherEur: number) {
  const r = await buy(`${config.seller.url}${lock.payPath || `/invoices/${encodeURIComponent(lock.invoiceId)}/pay`}`, `Lock ${lock.id}: pay ${lock.invoiceId} (${lock.supplier})`, { reservedEur: reservedOtherEur });
  accountsCache = null; // balances just changed
  return { txHash: r.receipt?.txHash, explorerUrl: r.receipt?.explorerUrl, receiptSeq: r.receipt?.seq };
}

const lockRoute = (fn: (req: express.Request) => Promise<unknown> | unknown) => async (req: express.Request, res: express.Response) => {
  try {
    const out = await fn(req);
    res.json({ ok: true, lock: out && typeof out === "object" && "id" in (out as any) ? withExplorer(out as Lock) : out });
  } catch (e) {
    const refused = e instanceof LockError ? e.refused : e instanceof PaymentRefused;
    res.status(refused ? 409 : 502).json({ ok: false, refused, error: (e as Error).message });
  }
};

app.get("/api/locks", (_req, res) => res.json({ locks: readLocks().map(withExplorer).reverse(), totals: lockTotals() }));
/** Judges may only act on locks for judge demo invoices. */
function judgeLock(req: express.Request) {
  if (roleOf(req) !== "judge") return;
  const l = readLocks().find((x) => x.id === req.params.id);
  if (l && !isDemoInvoice(l.invoiceId)) throw new LockError("judges work on judge demo invoices only; this lock belongs to the owner");
}
app.post("/api/locks", lockRoute(async (req) => {
  const role = roleOf(req);
  if (role === "judge") assertJudgeInvoice(String(req.body?.invoiceId || ""));
  return createLock(await invoiceRef(String(req.body?.invoiceId || "")), role);
}));
// One click: create (if needed) → fund → send to the agent's checks, stopping at "awaiting release".
app.post("/api/locks/prepare", lockRoute(async (req) => {
  const role = roleOf(req);
  const invoiceId = String(req.body?.invoiceId || "");
  if (role === "judge") assertJudgeInvoice(invoiceId);
  let lock = readLocks().find((l) => l.invoiceId === invoiceId && l.status !== "cancelled" && l.status !== "released")
    ?? createLock(await invoiceRef(invoiceId), role);
  if (lock.status === "created") lock = fundLock(lock.id, role);
  if (lock.status === "funded") lock = await sendLock(lock.id, async (l) => l); // never auto-release here
  return lock;
}));
app.post("/api/locks/:id/fund", lockRoute((req) => { judgeLock(req); return fundLock(req.params.id, roleOf(req)); }));
app.post("/api/locks/:id/send", lockRoute((req) => { judgeLock(req); return sendLock(req.params.id, (l) => releaseLock(l.id, "agent", payLock)); }));
// Owner wallet approval: get a one-time challenge, sign it in the wallet, then release with the signature.
app.post("/api/locks/:id/release-challenge", lockRoute(async (req) => {
  const l = readLocks().find((x) => x.id === req.params.id);
  if (!l) throw new LockError(`unknown lock ${req.params.id}`);
  if (l.status !== "sent") throw new LockError(`lock is ${l.status}, not awaiting release`);
  // Check the payment can go through before asking the owner to sign anything.
  const problem = await fundsProblem(l);
  if (problem) throw new LockError(problem);
  return createChallenge(l);
}));
app.post("/api/locks/:id/release", lockRoute(async (req) => {
  const l = readLocks().find((x) => x.id === req.params.id);
  if (l && l.status === "sent") { const problem = await fundsProblem(l); if (problem) throw new LockError(problem); }
  if (roleOf(req) === "judge") { judgeLock(req); return releaseLock(req.params.id, "judge", payLock, async (l) => judgeApproval(l)); }
  return releaseLock(req.params.id, "owner", payLock, () => verifyApproval(req.params.id, req.body ?? {}));
}));
app.post("/api/locks/:id/cancel", lockRoute((req) => { judgeLock(req); return cancelLock(req.params.id, roleOf(req), String(req.body?.note || "")); }));

// Judge demo: a fresh small invoice (kind "normal") or one over the limits (kind "over-limit"), from the seller.
app.post("/api/invoices/demo", async (req, res) => {
  try {
    const r = await fetch(`${config.seller.url}/invoices/demo`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: req.body?.kind === "over-limit" ? "over-limit" : "normal" }), signal: AbortSignal.timeout(8000),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: body.error || `seller HTTP ${r.status}` });
    audit({ actor: roleOf(req), op: "demo-invoice", outcome: "ok", detail: `Judge demo invoice ${body.invoice.id} created: ${body.invoice.supplier}, €${body.invoice.amountEur.toLocaleString()}` });
    res.json(body);
  } catch (e) {
    res.status(502).json({ error: `seller unreachable at ${config.seller.url}: ${(e as Error).message}` });
  }
});

app.listen(PORT, HOST, () => {
  // Ask the registry about our suppliers once now, so the first payment doesn't wait for it.
  setTimeout(async () => {
    try {
      const r = await getJson(`${config.seller.url}/invoices`);
      if (!r.ok) return;
      if (r.body.payTo) checkBadge(r.body.payTo).catch(() => {});
      for (const i of r.body.items ?? []) if (i.status !== "paid" && i.payTo) verifyPayee(i.network, i.payTo).catch(() => {});
    } catch { /* seller not up yet: the first screen load will check */ }
  }, 1500);
  console.log(`${APP_NAME} dashboard on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(judgeOpen()
    ? "Open judge mode: no passwords. This computer = owner; anyone on the remote link = judge (capped demo). Link: npm run remote"
    : authEnabled() ? "Owner login: on (DASHBOARD_PASSWORD set). Phone access: npm run remote" : "Owner login: off (local only). Set DASHBOARD_PASSWORD in .env to enable sign-in and phone access.");
});
