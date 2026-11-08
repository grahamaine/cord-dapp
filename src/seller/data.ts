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
