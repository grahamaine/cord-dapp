import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { eurToAtomic, INVOICE_ASSET } from "../lib/eur.js";
import { XCHAINS, type ChainKey } from "../lib/chains.js";

/**
 * FALLBACK tenders, used only until the first live fetch from Uganda's Government Procurement Portal
 * succeeds (see src/lib/tenders.ts and `npm run tenders`).
 */
export const tenders = [
  { id: "UG-ENT-2026-0141", ocid: "", method: "", entity: "Sample Municipal Council", sector: "hospitality", title: "Supply of linen and towels", closes: "2026-12-04", currency: "UGX", estimate: 48_000_000 },
  { id: "UG-WAK-2026-0098", ocid: "", method: "", entity: "Sample Regional Hospital", sector: "food", title: "Framework contract: fresh produce", closes: "2026-12-11", currency: "UGX", estimate: 120_000_000 },
  { id: "UG-KLA-2026-0310", ocid: "", method: "", entity: "Sample University", sector: "it", title: "Campus Wi-Fi upgrade", closes: "2026-12-18", currency: "UGX", estimate: 310_000_000 },
  { id: "UG-ENT-2026-0152", ocid: "", method: "", entity: "Sample Aviation School", sector: "hospitality", title: "Catering services, 12 months", closes: "2026-12-20", currency: "UGX", estimate: 95_000_000 },
];

export const benchmarks: Record<string, { unit: string; low: number; median: number; high: number; samples: number }> = {
  "bath towel": { unit: "piece", low: 18_000, median: 24_500, high: 35_000, samples: 37 },
  "bed sheet (double)": { unit: "piece", low: 32_000, median: 41_000, high: 58_000, samples: 29 },
  "rice (25kg)": { unit: "bag", low: 105_000, median: 118_000, high: 132_000, samples: 52 },
  "cooking oil (20l)": { unit: "jerrycan", low: 140_000, median: 152_000, high: 171_000, samples: 44 },
};

/**
 * Supplier invoices for the owner page (lead example: a hotel in Entebbe paying its regular providers).
 * The suppliers are real businesses that serve Entebbe hotels; the invoices themselves are ILLUSTRATIVE
 * (numbers, dates and amounts are made up, and on testnet every payment goes to TenderScout's demo
 * accounts, not to these companies).
 *
 * Amounts are in EUR; `amount` is what settles on-chain in `asset` on the invoice's `chain`:
 *   concordium  INVOICE_ASSET: a PLT stablecoin such as EURR at full value, or CCD at the demo rate
 *   base        EURC on Base Sepolia    (demo scale: EUR 1,000 = 1 EURC, see src/lib/chains.ts)
 *   solana      EURC on Solana devnet   (same scale)
 */
export interface Invoice {
  id: string;
  supplier: string;
  category: string;
  description: string;
  issued: string;
  due: string;
  amountEur: number;
  amount: string; // atomic units of `asset` charged on-chain
  asset: string; // settlement asset symbol (INVOICE_ASSET on Concordium, EURC on Base/Solana)
  chain: ChainKey; // settlement chain
}
type InvoiceInput = Omit<Invoice, "amount" | "asset" | "chain"> & { chain?: ChainKey };
const inv = ({ chain = "concordium", ...i }: InvoiceInput): Invoice => {
  const asset = chain === "concordium" ? INVOICE_ASSET : XCHAINS[chain].asset;
  return { ...i, chain, asset, amount: eurToAtomic(i.amountEur, asset) };
};
export const invoices: Invoice[] = [
  inv({ id: "INV-LAU-1107", supplier: "Mother Laundry", category: "Laundry", description: "Linen & towel laundry, 1–15 Nov", issued: "2026-11-15", due: "2026-11-29", amountEur: 1850 }),
  inv({ id: "INV-PRO-2231", supplier: "Pure Grow Africa", category: "Food supply", description: "Vegetables & fruit, week 46", issued: "2026-11-16", due: "2026-11-23", amountEur: 2420 }),
  inv({ id: "INV-TRN-0418", supplier: "Airport Taxi Services (Entebbe)", category: "Transport", description: "Guest airport transfers, 14 trips", issued: "2026-11-17", due: "2026-12-01", amountEur: 980 }),
  inv({ id: "INV-MNT-0092", supplier: "Handymen Uganda", category: "Maintenance", description: "Kitchen drainage repair", issued: "2026-11-18", due: "2026-12-02", amountEur: 640 }),
  inv({ id: "INV-SEC-1130", supplier: "Corporate Security Services (U) Ltd", category: "Security", description: "Site security, November (4 guards) · settles on Solana", issued: "2026-11-18", due: "2026-11-30", amountEur: 3200, chain: "solana" }),
  inv({ id: "INV-NET-5521", supplier: "MTN Uganda (Business Internet)", category: "Internet & telecoms", description: "Business fibre, December · settles on Base", issued: "2026-11-19", due: "2026-12-01", amountEur: 1150, chain: "base" }),
  inv({ id: "INV-CON-0007", supplier: "Excel Construction Ltd", category: "Construction", description: "Kitchen refurbishment, phase 1 (over the €10,000 cap)", issued: "2026-11-19", due: "2026-12-15", amountEur: 12500 }),
];

/**
 * Judge demo invoices: small, fresh invoices created on demand from the owner dashboard so judges can run the
 * whole flow (create → fund → send → release) without using up the invoices above. They always settle on
 * Concordium in CCD at the demo rate (tiny testnet amounts). Stored in data/demo-invoices.json on the owner's
 * computer; never created on Vercel.
 */
const demoPath = () => process.env.DEMO_INVOICES_PATH || "data/demo-invoices.json";
const DEMO_SUPPLIERS = [
  { supplier: "Mother Laundry", category: "Laundry", description: "Extra linen run (judge demo)" },
  { supplier: "Pure Grow Africa", category: "Food supply", description: "Fruit top-up (judge demo)" },
  { supplier: "Airport Taxi Services (Entebbe)", category: "Transport", description: "Two airport transfers (judge demo)" },
  { supplier: "Handymen Uganda", category: "Maintenance", description: "Door lock repair (judge demo)" },
];
export function demoInvoices(): Invoice[] {
  if (!existsSync(demoPath())) return [];
  try { return JSON.parse(readFileSync(demoPath(), "utf8")); } catch { return []; }
}
/** kind "normal": €150–€900, within every limit. kind "over-limit": €12,000, so judges can watch the agent refuse it. */
export function createDemoInvoice(kind: "normal" | "over-limit" = "normal"): Invoice {
  const all = demoInvoices();
  const s = DEMO_SUPPLIERS[all.length % DEMO_SUPPLIERS.length];
  const today = new Date();
  const due = new Date(today.getTime() + 7 * 86_400_000);
  const amountEur = kind === "over-limit" ? 12_000 : 150 + 50 * Math.floor(Math.random() * 16);
  const invoice: Invoice = {
    id: `DEMO-${randomBytes(2).toString("hex").toUpperCase()}`,
    supplier: kind === "over-limit" ? "Excel Construction Ltd" : s.supplier,
    category: kind === "over-limit" ? "Construction" : s.category,
    description: kind === "over-limit" ? "Large refurbishment (judge demo, over the €10,000 cap)" : s.description,
    issued: today.toISOString().slice(0, 10),
    due: due.toISOString().slice(0, 10),
    amountEur,
    asset: "CCD",
    amount: eurToAtomic(amountEur, "CCD"),
    chain: "concordium",
  };
  mkdirSync(dirname(demoPath()), { recursive: true });
  writeFileSync(demoPath(), JSON.stringify([...all, invoice].slice(-50), null, 2) + "\n");
  return invoice;
}
/** The fixed invoices plus any judge demo invoices. */
export const allInvoices = (): Invoice[] => (process.env.VERCEL ? invoices : [...invoices, ...demoInvoices()]);
