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
import { config } from "../lib/config.js";
import { checkBadge } from "../lib/badge.js";
import { appendReceipt, readReceipts } from "../lib/receipts.js";
import { benchmarks, invoices, tenders } from "./data.js";

const payTo = config.seller.payTo();
const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: config.facilitator.url })).register(
  config.network,
  new ExactConcordiumScheme(),
);

const invoicePath = (id: string) => `/invoices/${id}/pay`;
const findInvoice = (id: string) => invoices.find((i) => i.id === id);
/** An invoice is paid once a settled receipt exists for its pay URL (the receipt log is the source of truth). */
function invoicePayment(id: string) {
  return readReceipts().find((r) => r.role === "seller" && r.resource.split("?")[0] === invoicePath(id));
}
const invoiceIdFromPath = (path: string) => decodeURIComponent(path.split("/")[2] ?? "");

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

app.get("/", (_req, res) =>
  res.json({
    agent: "TenderScout",
    by: "Cord",
    paid: ["GET /tenders?sector=", "GET /price-benchmark?item=", "GET /invoices/:id/pay"],
    free: ["GET /invoices", "GET /healthz"],
    card: "/.well-known/agent-card.json",
    facilitator: config.facilitator.url,
  }),
);

app.get("/healthz", (_req, res) =>
  res.json({ ok: true, agent: "TenderScout", payTo, badge: config.seller.badge || null, requireBuyerBadge: config.seller.requireBuyerBadge, network: config.network }),
);

// Public: open supplier invoices and their payment status.
app.get("/invoices", (_req, res) =>
  res.json({
    payTo,
    asset: config.seller.asset,
    items: invoices.map((inv) => {
      const r = invoicePayment(inv.id);
      return { ...inv, payTo, asset: config.seller.asset, status: r ? "paid" : "open", paidTx: r?.txHash ?? null, paidAt: r?.ts ?? null };
    }),
  }),
);

// Refuse unknown or already-paid invoices BEFORE quoting a price, so nothing is paid twice.
app.use("/invoices/:id/pay", (req, res, next) => {
  const inv = findInvoice(req.params.id);
  if (!inv) return res.status(404).json({ error: "unknown_invoice" });
  const r = invoicePayment(inv.id);
  if (r) return res.status(409).json({ error: "already_paid", tx: r.txHash, paidAt: r.ts });
  next();
});

// Public: Agent Card (hash-anchored on-chain in the CIS-8004 registry)
app.get("/.well-known/agent-card.json", (_req, res) => {
  const path = "data/agent-card.seller.json";
  if (!existsSync(path)) return res.status(404).json({ error: "run `npm run card -- seller` first" });
  // serve the exact bytes so the SHA-256 matches the on-chain metadata_hash
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
      "GET /tenders": route(config.seller.priceTenders, "Open public tenders by sector (Uganda)"),
      "GET /price-benchmark": route(config.seller.priceBenchmark, "Supplier price benchmark for an item"),
      "GET /invoices/:id/pay": route(
        (ctx) => ({ amount: findInvoice(invoiceIdFromPath(ctx.path))?.amount ?? "0", asset: config.seller.asset }),
        "Settle a supplier invoice",
      ),
    },
    resourceServer,
  ),
);

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
        sellerAccount: payTo,
        sellerBadge: config.seller.badge || undefined,
        amount: req.path.startsWith("/invoices/")
          ? findInvoice(invoiceIdFromPath(req.path))?.amount ?? "0"
          : req.path === "/tenders" ? config.seller.priceTenders : config.seller.priceBenchmark,
        asset: config.seller.asset,
        network: config.network,
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
  res.json({ source: "TenderScout (sample data)", items: sector ? tenders.filter((t) => t.sector === sector) : tenders });
});

app.get("/invoices/:id/pay", (req, res) => {
  const inv = findInvoice(req.params.id)!;
  res.json({ invoice: inv.id, supplier: inv.supplier, status: "paid", amountUgx: inv.amountUgx, settled: { amount: inv.amount, asset: config.seller.asset } });
});

app.get("/price-benchmark", (req, res) => {
  const item = String(req.query.item ?? "").toLowerCase();
  const b = benchmarks[item];
  if (!b) return res.status(404).json({ error: "unknown item", known: Object.keys(benchmarks) });
  res.json({ item, currency: "UGX", ...b });
});

if (!process.env.VERCEL) app.listen(config.seller.port, () =>
  console.log(`TenderScout seller on :${config.seller.port}, payTo ${payTo}, buyer badge required: ${config.seller.requireBuyerBadge}`),
);
