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
 * SAMPLE supplier invoices for the owner page (lead example: a hotel's recurring service providers). Amounts are shown in UGX; on testnet each is
 * settled with a small CCD amount (atomic units, 6 decimals) so demos don't drain test funds.
 * In production the invoice would be priced in a PLT stablecoin (e.g. USDR) at the real value.
 */
export interface Invoice {
  id: string;
  supplier: string;
  category: string;
  description: string;
  issued: string;
  due: string;
  amountUgx: number;
  amount: string; // atomic units of PRICE_ASSET charged on-chain
}
export const invoices: Invoice[] = [
  { id: "INV-LAU-1107", supplier: "Lakeside Laundry Services", category: "Laundry", description: "Linen & towel laundry, 1–15 Nov", issued: "2026-11-15", due: "2026-11-29", amountUgx: 1_850_000, amount: "300000" },
  { id: "INV-PRO-2231", supplier: "Entebbe Fresh Produce", category: "Food supply", description: "Vegetables & fruit, week 46", issued: "2026-11-16", due: "2026-11-23", amountUgx: 2_420_000, amount: "400000" },
  { id: "INV-TRN-0418", supplier: "Kitooro Airport Transfers", category: "Transport", description: "Guest airport transfers, 14 trips", issued: "2026-11-17", due: "2026-12-01", amountUgx: 980_000, amount: "150000" },
  { id: "INV-MNT-0092", supplier: "Wakiso Plumbing & Repairs", category: "Maintenance", description: "Kitchen drainage repair", issued: "2026-11-18", due: "2026-12-02", amountUgx: 640_000, amount: "100000" },
  { id: "INV-SEC-1130", supplier: "Lakeside Guard Services", category: "Security", description: "Site security, November (4 guards)", issued: "2026-11-18", due: "2026-11-30", amountUgx: 3_200_000, amount: "450000" },
  { id: "INV-NET-5521", supplier: "Entebbe Fibre Internet", category: "Internet & telecoms", description: "Business fibre 100 Mbps, December", issued: "2026-11-19", due: "2026-12-01", amountUgx: 1_150_000, amount: "200000" },
];
