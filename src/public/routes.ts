/**
 * Public, read-only Cord site (served by the seller app, so it runs on Vercel and locally).
 *   GET /                     landing page + live dashboard (HTML for browsers; agents still get JSON)
 *   GET /api/public/overview  verified agents (Agent Registry) + recent payments (on-chain history)
 *
 * Uses only public data: the registry's badge checks and the seller account's on-chain
 * transaction history. No keys, no local files, nothing that can move money.
 */
import { Router, type Request } from "express";
import { existsSync, readFileSync } from "node:fs";
import { getExplorerTxUrl } from "@x402/concordium";
import { config } from "../lib/config.js";
import { mountAssets } from "../ui/assets.js";
import { fmtAtomic, isCcd } from "../lib/eur.js";
import { tokenBalances } from "../lib/plt.js";
import { onChain, readSnapshot } from "../judge/routes.js";

const APP_NAME = process.env.APP_NAME || "Kakasa";
const TESTNET = config.network === "ccd:4221332d34e1694168c2a0c0b3fd0f27";
const WALLET_PROXY = process.env.WALLET_PROXY || (TESTNET ? "https://wallet-proxy.testnet.concordium.com" : "https://wallet-proxy.mainnet.concordium.software");

const AGENTS = [
  {
    key: "seller",
    name: "TenderScout",
    role: "Supplier agent",
    blurb: "Collects payment for supplier invoices. Only serves buyers with a valid badge.",
    badge: process.env.SELLER_BADGE || "JyP9TwhskJ6cKHDzW23Yj",
    card: "/.well-known/agent-card.json",
  },
  {
    key: "buyer",
    name: "ProcureBot",
    role: "Purchasing agent",
    blurb: "Pays invoices within the owner's limits, and only to verified suppliers.",
    badge: process.env.BUYER_BADGE || "JyP9U3BHQRbFTuQx4N1Gn",
    card: "/procurebot/.well-known/agent-card.json",
  },
];

async function getJson(url: string, ms = 12000): Promise<any> {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function agentStatus(a: (typeof AGENTS)[number]) {
  try {
    const b = await getJson(`${config.registry.api}/v1/badge-check/${a.badge}`);
    const onChain = b.on_chain ?? {};
    return {
      ...a,
      tokenId: b.token_id ?? null,
      owner: onChain.owner_account ?? null,
      status: onChain.status ?? null,
      valid: Boolean(b.badge_valid),
      cardSha256: b.card_sha256 ?? null,
      checks: b.checks ?? {},
      issues: (b.issues ?? []).map((i: any) => i.message),
      verifyUrl: `${config.registry.api}/v1/badge-check/${a.badge}`,
    };
  } catch (e) {
    return { ...a, tokenId: null, owner: null, status: null, valid: false, cardSha256: null, checks: {}, issues: [`registry unreachable: ${(e as Error).message}`], verifyUrl: `${config.registry.api}/v1/badge-check/${a.badge}` };
  }
}

/** Successful transfers into the seller account from verified buyer accounts, newest first. */
async function payments(seller: string, buyers: Set<string>) {
  const q = new URLSearchParams({ limit: "50", order: "descending" });
  const r = await getJson(`${WALLET_PROXY}/v1/accTransactions/${seller}?${q}`);
  return (r.transactions ?? [])
    .filter((t: any) => {
      const d = t.details ?? {};
      return String(d.type ?? "").startsWith("transfer") && d.outcome === "success" && d.transferDestination === seller && buyers.has(d.transferSource);
    })
    .map((t: any) => ({
      txHash: t.transactionHash,
      time: new Date(Number(t.blockTime) * 1000).toISOString(),
      from: t.details.transferSource,
      to: t.details.transferDestination,
      amount: String(t.details.transferAmount ?? t.subtotal ?? "0"),
      asset: "CCD",
      explorerUrl: getExplorerTxUrl(config.network, t.transactionHash),
    }));
}

/**
 * Stablecoin (PLT) invoice payments. The wallet service above lists CCD transfers; token transfers are taken
 * from the published records (judge/snapshot.json) and each one is confirmed on Concordium before it is shown.
 */
async function stablecoinPayments(seller: string) {
  const snap = readSnapshot();
  if (!snap) return [];
  const rows = snap.receipts.filter((r) => r.role === "buyer" && r.txHash && r.asset && !isCcd(r.asset) && r.sellerAccount === seller);
  const checked = await Promise.all(rows.map(async (r) => {
    const tx = await onChain(r.txHash!).catch(() => ({ finalized: false, success: false }));
    return tx.finalized && tx.success
      ? { txHash: r.txHash!, time: r.ts, from: r.buyerAccount ?? "", to: r.sellerAccount, amount: r.amount, asset: r.asset, explorerUrl: r.explorerUrl || getExplorerTxUrl(config.network, r.txHash!) }
      : null;
  }));
  return checked.filter((x) => x !== null);
}

let cache: { at: number; body: unknown } | undefined;
/** The three Kakasa accounts with live balances (all public on-chain data; nothing here needs a key). */
async function accounts(agents: any[]) {
  const explorer = (a: string) => `https://ccdexplorer.io/${TESTNET ? "testnet" : "mainnet"}/account/${a}`;
  const list = [
    { key: "buyer", name: "ProcureBot", role: "Purchasing agent: pays approved supplier invoices", address: agents.find((a) => a.key === "buyer")?.owner || "" },
    { key: "seller", name: "TenderScout", role: "Supplier agent: receives payments", address: process.env.SELLER_PAY_TO || agents.find((a) => a.key === "seller")?.owner || "" },
    { key: "facilitator", name: "Kakasa facilitator", role: "Sponsor: pays the network fees so agents need no gas", address: process.env.PUBLIC_FACILITATOR_ADDRESS || "" },
  ].filter((a) => a.address);
  return Promise.all(list.map(async (a) => {
    try {
      const b = await getJson(`${WALLET_PROXY}/v0/accBalance/${a.address}`);
      const atomic = String(b?.finalizedBalance?.accountAmount ?? b?.currentBalance?.accountAmount ?? "");
      const tokens = await tokenBalances(a.address).catch(() => []);
      return { ...a, balance: atomic || null, tokens: tokens.map((t) => ({ ...t, display: fmtAtomic(t.amount, t.asset) })), explorerUrl: explorer(a.address) };
    } catch {
      return { ...a, balance: null, tokens: [], explorerUrl: explorer(a.address) };
    }
  }));
}

async function overview() {
  if (cache && Date.now() - cache.at < 30_000) return cache.body;
  const agents = await Promise.all(AGENTS.map(agentStatus));
  const seller = process.env.SELLER_PAY_TO || agents.find((a) => a.key === "seller")?.owner || "";
  const buyerOwners = new Set(agents.filter((a) => a.key === "buyer" && a.owner).map((a) => a.owner as string));
  let pays: any[] = [];
  let paymentsError: string | null = null;
  try {
    pays = seller && buyerOwners.size ? await payments(seller, buyerOwners) : [];
    if (seller) pays = [...pays, ...(await stablecoinPayments(seller))].sort((a, b) => (a.time < b.time ? 1 : -1));
  } catch (e) {
    paymentsError = `payment history unavailable: ${(e as Error).message}`;
  }
  const body = {
    app: APP_NAME,
    network: config.network,
    testnet: TESTNET,
    registry: { contract: process.env.REGISTRY_CONTRACT || "12802.0" },
    agents,
    payments: pays.map((p) => ({ ...p, display: fmtAtomic(p.amount, p.asset) })),
    paymentsError,
    accounts: await accounts(agents),
    totals: {
      count: pays.length,
      // kept for older clients: CCD only
      amount: pays.filter((p) => isCcd(p.asset)).reduce((s, p) => s + BigInt(p.amount), 0n).toString(),
      byAsset: Object.entries(
        pays.reduce<Record<string, bigint>>((acc, p) => ((acc[p.asset] = (acc[p.asset] ?? 0n) + BigInt(p.amount)), acc), {}),
      ).map(([asset, sum]) => fmtAtomic(sum, asset)),
    },
    updatedAt: new Date().toISOString(),
  };
  cache = { at: Date.now(), body };
  return body;
}

const wantsHtml = (req: Request) => req.accepts(["json", "html"]) === "html";
// Read relative to the project root (works locally and in the Vercel bundle via includeFiles).
const PAGE_PATH = "src/public/index.html";
const page = () =>
  (existsSync(PAGE_PATH) ? readFileSync(PAGE_PATH, "utf8") : readFileSync(new URL("./index.html", import.meta.url), "utf8")).replaceAll("{{APP_NAME}}", APP_NAME);

export function publicRouter() {
  const r = Router();
  mountAssets(r);
  r.get("/", (req, res, next) => (wantsHtml(req) ? res.type("html").send(page()) : next()));
  r.get("/api/public/overview", async (_req, res) => {
    try {
      res.set("cache-control", "public, max-age=15").json(await overview());
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });
  return r;
}
