import "dotenv/config";
import { CONCORDIUM_TESTNET_CAIP2 } from "@x402/concordium";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Missing env var ${name} (see .env.example)`);
  return v;
}
const opt = (name: string, fallback = "") => process.env[name] || fallback;
// On Vercel, default URLs to this deployment's production domain.
const vercelBase = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "";
const bool = (name: string, fallback: boolean) =>
  process.env[name] === undefined ? fallback : process.env[name] === "true";

export const config = {
  network: opt("CCD_NETWORK", CONCORDIUM_TESTNET_CAIP2) as `${string}:${string}`,
  grpc: { host: opt("CCD_GRPC_HOST", "grpc.testnet.concordium.com"), port: Number(opt("CCD_GRPC_PORT", "20000")) },
  registry: { api: opt("REGISTRY_API", "https://agent-registry-mcp.concordium.com"), network: opt("REGISTRY_NETWORK", "testnet") },
  facilitator: {
    port: Number(opt("FACILITATOR_PORT", "4020")),
    url: opt("FACILITATOR_URL", vercelBase ? `${vercelBase}/facilitator` : "http://localhost:4020"),
    address: () => env("CCD_FACILITATOR_ADDRESS"),
    privateKey: () => env("CCD_FACILITATOR_PRIVATE_KEY"),
  },
  seller: {
    port: Number(opt("SELLER_PORT", "4021")),
    url: opt("SELLER_URL", vercelBase || "http://localhost:4021"),
    payTo: () => env("SELLER_PAY_TO"),
    badge: opt("SELLER_BADGE"),
    asset: opt("PRICE_ASSET", "CCD"), // data calls (tenders, benchmarks)
    invoiceAsset: opt("INVOICE_ASSET", opt("PRICE_ASSET", "CCD")), // supplier invoices
    priceTenders: opt("PRICE_TENDERS", "100000"),
    priceBenchmark: opt("PRICE_BENCHMARK", "250000"),
    requireBuyerBadge: bool("REQUIRE_BUYER_BADGE", true),
  },
  buyer: {
    address: () => env("CCD_ADDRESS"),
    privateKey: () => env("CCD_PRIVATE_KEY"),
    badge: opt("BUYER_BADGE"),
    maxPayment: BigInt(opt("MAX_PAYMENT", "1000000")),
    allowedAssets: opt("ALLOWED_ASSETS", "CCD,EURR,USDR,EURC").split(",").map((a) => a.trim()).filter(Boolean),
    requireSellerBadge: bool("REQUIRE_SELLER_BADGE", true),
  },
  receiptsPath: opt("RECEIPTS_PATH", process.env.VERCEL ? "/tmp/receipts.jsonl" : "data/receipts.jsonl"),
};
