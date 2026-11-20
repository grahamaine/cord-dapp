import { eurToAtomic } from "../lib/eur.js";

/**
 * SAMPLE DATA for the demo. Replace with a real source (e.g. a scraper over the Uganda
 * Government Procurement Portal, PPDA notices, or your own supplier quote history).
 */
export const tenders = [
  { id: "UG-ENT-2026-0141", entity: "Sample Municipal Council", sector: "hospitality", title: "Supply of linen and towels", closes: "2026-12-04", currency: "UGX", estimate: 48_000_000 },
  { id: "UG-WAK-2026-0098", entity: "Sample Regional Hospital", sector: "food", title: "Framework contract: fresh produce", closes: "2026-12-11", currency: "UGX", estimate: 120_000_000 },
  { id: "UG-KLA-2026-0310", entity: "Sample University", sector: "it", title: "Campus Wi-Fi upgrade", closes: "2026-12-18", currency: "UGX", estimate: 310_000_000 },
  { id: "UG-ENT-2026-0152", entity: "Sample Aviation School", sector: "hospitality", title: "Catering services, 12 months", closes: "2026-12-20", currency: "UGX", estimate: 95_000_000 },
];

export const benchmarks: Record<string, { unit: string; low: number; median: number; high: number; samples: number }> = {
  "bath towel": { unit: "piece", low: 18_000, median: 24_500, high: 35_000, samples: 37 },
  "bed sheet (double)": { unit: "piece", low: 32_000, median: 41_000, high: 58_000, samples: 29 },
  "rice (25kg)": { unit: "bag", low: 105_000, median: 118_000, high: 132_000, samples: 52 },
  "cooking oil (20l)": { unit: "jerrycan", low: 140_000, median: 152_000, high: 171_000, samples: 44 },
};

/**
 * SAMPLE supplier invoices for the owner page (lead example: a hotel's recurring service providers).
 * Amounts are in demo EUR; `amount` is what settles on-chain (see src/lib/eur.ts for the demo rate).
 * In production the invoice would be priced in a euro stablecoin at full value.
 */
export interface Invoice {
  id: string;
  supplier: string;
  category: string;
  description: string;
  issued: string;
  due: string;
  amountEur: number;
  amount: string; // atomic units of PRICE_ASSET charged on-chain (demo rate)
}
const inv = (i: Omit<Invoice, "amount">): Invoice => ({ ...i, amount: eurToAtomic(i.amountEur) });
export const invoices: Invoice[] = [
  inv({ id: "INV-LAU-1107", supplier: "Lakeside Laundry Services", category: "Laundry", description: "Linen & towel laundry, 1–15 Nov", issued: "2026-11-15", due: "2026-11-29", amountEur: 1850 }),
  inv({ id: "INV-PRO-2231", supplier: "Entebbe Fresh Produce", category: "Food supply", description: "Vegetables & fruit, week 46", issued: "2026-11-16", due: "2026-11-23", amountEur: 2420 }),
  inv({ id: "INV-TRN-0418", supplier: "Kitooro Airport Transfers", category: "Transport", description: "Guest airport transfers, 14 trips", issued: "2026-11-17", due: "2026-12-01", amountEur: 980 }),
  inv({ id: "INV-MNT-0092", supplier: "Wakiso Plumbing & Repairs", category: "Maintenance", description: "Kitchen drainage repair", issued: "2026-11-18", due: "2026-12-02", amountEur: 640 }),
  inv({ id: "INV-SEC-1130", supplier: "Lakeside Guard Services", category: "Security", description: "Site security, November (4 guards)", issued: "2026-11-18", due: "2026-11-30", amountEur: 3200 }),
  inv({ id: "INV-NET-5521", supplier: "Entebbe Fibre Internet", category: "Internet & telecoms", description: "Business fibre 100 Mbps, December", issued: "2026-11-19", due: "2026-12-01", amountEur: 1150 }),
  inv({ id: "INV-CON-0007", supplier: "Victoria Builders Ltd", category: "Construction", description: "Kitchen refurbishment, phase 1 (over the €10,000 cap)", issued: "2026-11-19", due: "2026-12-15", amountEur: 12500 }),
];
