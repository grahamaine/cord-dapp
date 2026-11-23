/**
 * TenderScout: a seller agent that sells procurement intelligence per call over x402.
 *  - Publishes an ERC-8004 / A2A Agent Card with the Verified by Concordium badge.
 *  - Only serves buyer agents that present a valid badge (X-Agent-Badge header).
 *  - Charges per request; fees are sponsored by the Cord facilitator.
 *  - Writes a hash-chained receipt for every settled sale.
 */
import express from "express";
import { existsSync, readFileSync } from "node:fs";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactConcordiumScheme } from "@x402/concordium/exact/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { XCHAINS, XCHAIN_FACILITATOR_URL, invoicePayPath, networkOf, sellerEvmPublicKey, sellerXAddress, type ChainKey } from "../lib/chains.js";
import { config } from "../lib/config.js";
import { checkBadge } from "../lib/badge.js";
import { appendReceipt, readReceipts } from "../lib/receipts.js";
import { benchmarks, invoices, tenders } from "./data.js";
import { currentTenders } from "../lib/tenders.js";
import { assetSpec, eurToAtomic, fmtAtomic, isCcd, settlementInfo } from "../lib/eur.js";
import { publicRouter } from "../public/routes.js";
import { judgeRouter } from "../judge/routes.js";

const payTo = config.seller.payTo();

// Base / Solana are offered only when TenderScout has a receiving address there (SELLER_EVM_ADDRESS,
// SELLER_SOLANA_ADDRESS). Their fees are paid by the x402 facilitator for those chains.
const xchainsOffered = (["base", "solana"] as const).filter((k) => sellerXAddress[k]());
// Two separate resource servers, so an outage of the public facilitator can never block Concordium payments.
const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: config.facilitator.url })).register(
  config.network,
  new ExactConcordiumScheme(),
);
const xchainServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: XCHAIN_FACILITATOR_URL }));
if (xchainsOffered.includes("base")) xchainServer.register(XCHAINS.base.network, new ExactEvmScheme());
if (xchainsOffered.includes("solana")) xchainServer.register(XCHAINS.solana.network, new ExactSvmScheme());

/** TenderScout's receiving address on a chain ("" if that chain isn't offered). */
const payToOn = (chain: ChainKey) => (chain === "concordium" ? payTo : sellerXAddress[chain]());

const findInvoice = (id: string) => invoices.find((i) => i.id === id);
const basePayPath = (id: string) => `/invoices/${id}/pay`;
/** An invoice is paid once a settled receipt exists for one of its pay URLs (the receipt log is the source of truth). */
function invoicePayment(id: string) {
  const base = basePayPath(id);
  return readReceipts().find((r) => {
    if (r.role !== "seller") return false;
    const path = r.resource.split("?")[0];
    return path === base || path === `${base}/base` || path === `${base}/solana`;
  });
}
const invoiceIdFromPath = (path: string) => decodeURIComponent(path.split("/")[2] ?? "");
const chainFromPath = (path: string): ChainKey => {
  const seg = path.split("?")[0].split("/")[4];
  return seg === "base" || seg === "solana" ? seg : "concordium";
};

const route = (amount: string | ((ctx: { path: string }) => { amount: string; asset: string }), description: string) => ({
  accepts: {
    scheme: "exact",
    network: config.network,
    payTo,
    price: typeof amount === "string" ? { amount, asset: config.seller.asset } : amount,
  },
  description,
  mimeType: "application/json",
});

export const app = express();

// Public read-only site (HTML for browsers) + /api/public/overview. Agents requesting JSON fall through.
app.use(publicRouter());
app.use(judgeRouter());

app.get("/", (_req, res) =>
  res.json({
    agent: "TenderScout",
    by: "Kakasa",
    paid: ["GET /tenders?sector=", "GET /price-benchmark?item=", "GET /invoices/:id/pay"],
    free: ["GET /invoices", "GET /healthz"],
    card: "/.well-known/agent-card.json",
    facilitator: config.facilitator.url,
    chains: { concordium: payTo, ...Object.fromEntries(xchainsOffered.map((k) => [k, sellerXAddress[k]()])) },
  }),
);

// Public keys behind TenderScout's non-Concordium receiving addresses, so buyers can look them up in the
// CIS-8 external key registry (an EVM address alone doesn't reveal its key; a Solana address is its key).
app.get("/.well-known/payee-keys.json", (_req, res) => {
  const keys: Record<string, { address: string; publicKey?: string }> = {};
  if (xchainsOffered.includes("base")) keys[XCHAINS.base.network] = { address: sellerXAddress.base(), publicKey: sellerEvmPublicKey() || undefined };
  if (xchainsOffered.includes("solana")) keys[XCHAINS.solana.network] = { address: sellerXAddress.solana() };
  res.json({ agent: "TenderScout", keys });
});

app.get("/healthz", (_req, res) =>
  res.json({ ok: true, agent: "TenderScout", payTo, xchains: Object.fromEntries(xchainsOffered.map((k) => [k, sellerXAddress[k]()])), invoiceAsset: config.seller.invoiceAsset, dataAsset: config.seller.asset, badge: config.seller.badge || null, requireBuyerBadge: config.seller.requireBuyerBadge, network: config.network }),
);

// Public: open supplier invoices and their payment status.
app.get("/invoices", (_req, res) =>
  res.json({
    payTo,
    asset: config.seller.invoiceAsset,
    settlement: settlementInfo(),
    items: invoices
      // An invoice on a chain TenderScout has no address on can't be paid: show it on Concordium instead.
      .map((inv) => (inv.chain !== "concordium" && !payToOn(inv.chain) ? { ...inv, chain: "concordium" as const, asset: config.seller.invoiceAsset, amount: eurToAtomic(inv.amountEur, config.seller.invoiceAsset) } : inv))
      .map((inv) => {
        const r = invoicePayment(inv.id);
        return { ...inv, payTo: payToOn(inv.chain), network: networkOf(inv.chain), payPath: invoicePayPath(inv.id, inv.chain), status: r ? "paid" : "open", paidTx: r?.txHash ?? null, paidAt: r?.ts ?? null, paidNetwork: r?.network ?? null };
      }),
  }),
);

// Refuse unknown or already-paid invoices BEFORE quoting a price, so nothing is paid twice.
app.use("/invoices/:id/pay", (req, res, next) => {
  const inv = findInvoice(req.params.id);
  if (!inv) return res.status(404).json({ error: "unknown_invoice" });
  const r = invoicePayment(inv.id);
  if (r) return res.status(409).json({ error: "already_paid", tx: r.txHash, paidAt: r.ts });
  const chain = chainFromPath(req.originalUrl);
  const expected = inv.chain !== "concordium" && !payToOn(inv.chain) ? "concordium" : inv.chain;
  if (chain !== expected) return res.status(409).json({ error: "wrong_chain", message: `invoice ${inv.id} settles on ${expected}`, payPath: invoicePayPath(inv.id, expected) });
  next();
});

// Public: Agent Card (hash-anchored on-chain in the CIS-8004 registry)
app.get("/.well-known/agent-card.json", (_req, res) => {
  const path = "data/agent-card.seller.json";
  if (!existsSync(path)) return res.status(404).json({ error: "run `npm run card -- seller` first" });
  // serve the exact bytes so the SHA-256 matches the on-chain metadata_hash
  res.type("application/json").send(readFileSync(path));
});

// Public: the buyer agent's (ProcureBot) card, hosted here so it has a public URL too.
app.get("/procurebot/.well-known/agent-card.json", (_req, res) => {
  const path = "data/agent-card.buyer.json";
  if (!existsSync(path)) return res.status(404).json({ error: "run `npm run card -- buyer` first" });
  res.type("application/json").send(readFileSync(path));
});

// Accountability gate: only identity-backed agents may buy. Runs BEFORE payment is requested.
app.use(["/tenders", "/price-benchmark", "/invoices/:id/pay"], async (req, res, next) => {
  if (!config.seller.requireBuyerBadge) return next();
  const badge = req.header("x-agent-badge");
  if (!badge) return res.status(403).json({ error: "badge_required", message: "Send X-Agent-Badge: <your CIS-8004 badge>" });
  const v = await checkBadge(badge);
  if (!v.verified) return res.status(403).json({ error: "badge_invalid", issues: v.issues });
  res.locals.buyerBadge = badge;
  next();
});

app.use(
  paymentMiddleware(
    {
      "GET /tenders": route(config.seller.priceTenders, "Open public tenders by sector, live from Uganda's Government Procurement Portal (PPDA open data)"),
      "GET /price-benchmark": route(config.seller.priceBenchmark, "Supplier price benchmark for an item"),
      "GET /invoices/:id/pay": route(
        (ctx) => {
          const inv = findInvoice(invoiceIdFromPath(ctx.path));
          // an invoice whose chain isn't offered falls back to Concordium in INVOICE_ASSET
          const onConcordium = inv && inv.chain !== "concordium";
          return onConcordium
            ? { amount: eurToAtomic(inv.amountEur, config.seller.invoiceAsset), asset: config.seller.invoiceAsset }
            : { amount: inv?.amount ?? "0", asset: inv?.asset ?? config.seller.invoiceAsset };
        },
        "Settle a supplier invoice",
      ),
    },
    resourceServer,
  ),
);

// Base Sepolia / Solana devnet invoices: EURC through the public x402 facilitator.
if (xchainsOffered.length) app.use(
  paymentMiddleware(
    {
      ...Object.fromEntries(xchainsOffered.map((k) => {
        const x = XCHAINS[k];
        return [`GET /invoices/:id/pay/${k}`, {
          accepts: {
            scheme: "exact",
            network: x.network,
            payTo: sellerXAddress[k](),
            price: (ctx: { path: string }) => {
              const inv = findInvoice(invoiceIdFromPath(ctx.path));
              return { amount: inv?.amount ?? "0", asset: x.token, ...(x.eip712 ? { extra: { ...x.eip712, assetTransferMethod: "eip3009" } } : {}) };
            },
          },
          description: `Settle a supplier invoice in EURC on ${x.name}`,
          mimeType: "application/json",
        }];
      })),
    },
    xchainServer,
  ),
);

// Log refused payments with their reason, so the seller window explains a 402 after a payment attempt.
app.use((req, res, next) => {
  res.on("finish", () => {
    if (res.statusCode !== 402 || !(req.header("payment-signature") || req.header("x-payment"))) return;
    for (const h of ["payment-required", "payment-response"]) {
      const raw = res.getHeader(h);
      if (!raw) continue;
      try {
        const j = JSON.parse(Buffer.from(String(raw), "base64").toString("utf8"));
        console.warn(`[seller] payment for ${req.originalUrl} refused: ${j.error || j.errorReason || j.invalidReason || "no reason"}${j.errorMessage ? ` (${j.errorMessage})` : ""}`);
      } catch { /* ignore */ }
    }
  });
  next();
});

// Record a receipt when the paid response goes out (settlement header is set by the middleware).
app.use((req, res, next) => {
  res.on("finish", () => {
    const header = res.getHeader("payment-response") ?? res.getHeader("x-payment-response");
    if (res.statusCode !== 200 || !header) return;
    try {
      const settle = JSON.parse(Buffer.from(String(header), "base64").toString("utf8"));
      appendReceipt({
        role: "seller",
        resource: req.originalUrl,
        buyerAccount: settle.payer,
        buyerBadge: res.locals.buyerBadge,
        sellerAccount: payToOn(chainFromPath(req.originalUrl)),
        sellerBadge: config.seller.badge || undefined,
        ...(req.path.startsWith("/invoices/")
          ? (({ amount, asset, amountEur, chain }) =>
              chain !== "concordium" && chainFromPath(req.originalUrl) === "concordium"
                ? { amount: eurToAtomic(amountEur, config.seller.invoiceAsset), asset: config.seller.invoiceAsset }
                : { amount, asset })(findInvoice(invoiceIdFromPath(req.path)) ?? { amount: "0", asset: config.seller.invoiceAsset, amountEur: 0, chain: "concordium" as ChainKey })
          : { amount: req.path === "/tenders" ? config.seller.priceTenders : config.seller.priceBenchmark, asset: config.seller.asset }),
        network: networkOf(chainFromPath(req.originalUrl)),
        txHash: settle.transaction,
      });
    } catch (e) {
      console.warn("[seller] could not record receipt:", (e as Error).message);
    }
  });
  next();
});

app.get("/tenders", (req, res) => {
  const sector = String(req.query.sector ?? "").toLowerCase();
  const set = currentTenders(tenders);
  const items = sector ? set.items.filter((t) => t.sector === sector) : set.items;
  res.json({ source: set.source, live: set.live, fiscalYear: set.fiscalYear, fetchedAt: set.fetchedAt || null, sector: sector || null, count: items.length, items: items.slice(0, Number(req.query.limit ?? 50)) });
});

app.get(["/invoices/:id/pay", "/invoices/:id/pay/:chain"], (req, res) => {
  const inv = findInvoice(req.params.id)!;
  const chain = chainFromPath(req.originalUrl);
  const asset = chain === inv.chain ? inv.asset : config.seller.invoiceAsset;
  const amount = chain === inv.chain ? inv.amount : eurToAtomic(inv.amountEur, asset);
  res.json({ invoice: inv.id, supplier: inv.supplier, status: "paid", amountEur: inv.amountEur, chain, settled: { amount, asset, display: fmtAtomic(amount, asset), fullValue: !isCcd(asset) && !assetSpec(asset).demo && assetSpec(asset).eurPerToken === 1 } });
});

app.get("/price-benchmark", (req, res) => {
  const item = String(req.query.item ?? "").toLowerCase();
  const b = benchmarks[item];
  if (!b) return res.status(404).json({ error: "unknown item", known: Object.keys(benchmarks) });
  res.json({ item, currency: "UGX", ...b });
});

if (!process.env.VERCEL) app.listen(config.seller.port, () => {
  console.log(`TenderScout seller on :${config.seller.port}, payTo ${payTo}, buyer badge required: ${config.seller.requireBuyerBadge}`);
  for (const k of xchainsOffered) console.log(`  also paid on ${XCHAINS[k].name} in EURC at ${sellerXAddress[k]()} (facilitator ${XCHAIN_FACILITATOR_URL})`);
  if (xchainsOffered.includes("base") && !sellerEvmPublicKey()) console.warn("  ! SELLER_EVM_PUBLIC_KEY is empty: buyers can't verify the Base address. Run npm run wallets.");
});
