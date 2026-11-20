/**
 * Cord web: the owner's dashboard and control page.
 *   Dashboard  - service status, account balances + badges, payments with CCDExplorer links,
 *                and the tamper-evident receipt chain.
 *   Owner      - spending policy (limits, approved suppliers, badge rule), supplier invoices,
 *                and a Pay button that runs the same trust-gated x402 flow as the CLI.
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
import { loadPolicy, savePolicy, spentToday } from "../lib/policy.js";
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
      spentToday: spentToday().toString(),
      dailyLimit: policy.dailyLimit,
    },
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
    res.json(savePolicy(req.body));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get("/api/invoices", async (_req, res) => {
  const r = await getJson(`${config.seller.url}/invoices`);
  if (!r.ok) return res.status(502).json({ error: `seller unreachable at ${config.seller.url}`, detail: r.body });
  const badge = r.body.payTo ? await checkBadge(r.body.payTo) : null;
  const items = (r.body.items ?? []).map((i: any) => ({ ...i, paidExplorerUrl: i.paidTx ? getExplorerTxUrl(config.network, i.paidTx) : null }));
  res.json({ ...r.body, items, payeeBadge: badge ? { verified: badge.verified, agents: badge.agents, issues: badge.issues } : null });
});

app.post("/api/invoices/:id/pay", async (req, res) => {
  const id = req.params.id;
  const purpose = String(req.body?.purpose || `Owner paid invoice ${id}`);
  try {
    const r = await buy(`${config.seller.url}/invoices/${encodeURIComponent(id)}/pay`, purpose);
    res.json({ ok: true, data: r.data, receipt: r.receipt ?? null, sellerVerified: r.sellerVerified });
  } catch (e) {
    const refused = e instanceof PaymentRefused;
    res.status(refused ? 403 : 502).json({ ok: false, refused, error: (e as Error).message });
  }
});

app.listen(PORT, HOST, () => console.log(`${APP_NAME} dashboard on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`));
