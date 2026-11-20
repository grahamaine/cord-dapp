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
import { readFileSync } from "node:fs";
import { getExplorerTxUrl } from "@x402/concordium";
import { config } from "../lib/config.js";
import { checkBadge } from "../lib/badge.js";
import { readReceipts, verifyChain, type Receipt } from "../lib/receipts.js";
import { loadPolicy, savePolicy, spentTodayEur } from "../lib/policy.js";
import { audit, readAudit, verifyAudit } from "../lib/audit.js";
import { createLock, fundLock, sendLock, releaseLock, cancelLock, readLocks, lockTotals, LockError, type Lock } from "../lib/locks.js";
import { atomicToEur, ATOMIC_PER_EUR } from "../lib/eur.js";
import { createChallenge, ownerAccounts, verifyApproval } from "../lib/approval.js";
import { CHAINS, verifyCrossChain } from "../lib/xchain.js";
import { buy, PaymentRefused } from "../buyer/procurebot.js";
import { mountAssets } from "../ui/assets.js";

const APP_NAME = process.env.APP_NAME || "Cord";
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
      explorerUrl: r.explorerUrl || (r.txHash ? getExplorerTxUrl(r.network as `${string}:${string}`, r.txHash) : null),
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
mountAssets(app);

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
      paid: rows.reduce((s, r) => s + BigInt(r.amount), 0n).toString(),
      paidEur: atomicToEur(rows.reduce((s, r) => s + BigInt(r.amount), 0n)),
      spentTodayEur: spentTodayEur(),
      dailyLimitEur: policy.dailyLimitEur,
      maxPerLockEur: policy.maxPerLockEur,
      ...lockTotals(),
    },
    policy: { paused: policy.paused, requireHumanRelease: policy.requireHumanRelease },
    audit: verifyAudit(),
    demoRate: { atomicPerEur: ATOMIC_PER_EUR.toString() },
  });
});

app.get("/api/accounts", async (_req, res) => {
  const out = await Promise.all(
    Object.entries(accounts).map(async ([role, address]) => {
      if (!address) return { role, address, missing: true };
      const [bal, badge] = await Promise.all([
        getJson(`${WALLET_PROXY}/v0/accBalance/${address}`),
        role === "facilitator" ? Promise.resolve(null) : checkBadge(address),
      ]);
      const b = bal.body?.finalizedBalance ?? bal.body?.currentBalance;
      return {
        role,
        address,
        balance: b?.accountAmount ?? null,
        balanceError: bal.ok ? null : `wallet proxy HTTP ${bal.status}`,
        badge: badge ? { verified: badge.verified, agents: badge.agents, issues: badge.issues } : null,
      };
    }),
  );
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
app.get("/api/wallet/config", (_req, res) =>
  res.json({
    network: config.registry.network,
    chainId: `ccd:${config.registry.network}`,
    walletConnectProjectId: process.env.WALLETCONNECT_PROJECT_ID || null,
    ownerAccounts: ownerAccounts(),
    requireOwnerSignature: loadPolicy().requireOwnerSignature,
  }),
);

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

app.get("/api/audit", (_req, res) => res.json({ chain: verifyAudit(), entries: readAudit().slice(-200).reverse() }));

app.get("/api/invoices", async (_req, res) => {
  const r = await getJson(`${config.seller.url}/invoices`);
  if (!r.ok) return res.status(502).json({ error: `seller unreachable at ${config.seller.url}`, detail: r.body });
  const badge = r.body.payTo ? await checkBadge(r.body.payTo) : null;
  const items = (r.body.items ?? []).map((i: any) => ({ ...i, paidExplorerUrl: i.paidTx ? getExplorerTxUrl(config.network, i.paidTx) : null }));
  res.json({ ...r.body, items, payeeBadge: badge ? { verified: badge.verified, agents: badge.agents, issues: badge.issues } : null });
});

// ---------------- payment locks: create → fund → send → release | cancel ----------------
async function invoiceRef(id: string) {
  const r = await getJson(`${config.seller.url}/invoices`);
  if (!r.ok) throw new LockError(`seller unreachable at ${config.seller.url}`, false);
  const i = (r.body.items ?? []).find((x: any) => x.id === id);
  if (!i) throw new LockError(`unknown invoice ${id}`);
  return { ...i, payTo: r.body.payTo, asset: r.body.asset };
}
const withExplorer = (l: Lock) => ({ ...l, explorerUrl: l.explorerUrl || (l.txHash ? getExplorerTxUrl(config.network, l.txHash) : undefined) });

/** Release = the only place money moves: a sponsored x402 payment through ProcureBot. */
async function payLock(lock: Lock, reservedOtherEur: number) {
  const r = await buy(`${config.seller.url}/invoices/${encodeURIComponent(lock.invoiceId)}/pay`, `Lock ${lock.id}: pay ${lock.invoiceId} (${lock.supplier})`, { reservedEur: reservedOtherEur });
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
app.post("/api/locks", lockRoute(async (req) => createLock(await invoiceRef(String(req.body?.invoiceId || "")), "owner")));
app.post("/api/locks/:id/fund", lockRoute((req) => fundLock(req.params.id, "owner")));
app.post("/api/locks/:id/send", lockRoute((req) => sendLock(req.params.id, (l) => releaseLock(l.id, "agent", payLock))));
// Owner wallet approval: get a one-time challenge, sign it in the wallet, then release with the signature.
app.post("/api/locks/:id/release-challenge", lockRoute((req) => {
  const l = readLocks().find((x) => x.id === req.params.id);
  if (!l) throw new LockError(`unknown lock ${req.params.id}`);
  if (l.status !== "sent") throw new LockError(`lock is ${l.status}, not awaiting release`);
  return createChallenge(l);
}));
app.post("/api/locks/:id/release", lockRoute((req) =>
  releaseLock(req.params.id, "owner", payLock, () => verifyApproval(req.params.id, req.body ?? {})),
));
app.post("/api/locks/:id/cancel", lockRoute((req) => cancelLock(req.params.id, "owner", String(req.body?.note || ""))));

app.listen(PORT, HOST, () => console.log(`${APP_NAME} dashboard on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`));
