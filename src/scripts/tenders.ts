/**
 * npm run tenders [-- 2026-2027] — fetch open public tenders from Uganda's Government Procurement Portal
 * (PPDA open data, OCDS) into data/tenders.json, which TenderScout sells at GET /tenders.
 * Commit data/tenders.json to give the Vercel copy of TenderScout the same list.
 */
import { fetchLiveTenders, fiscalYear, saveTenders, TENDER_SECTORS } from "../lib/tenders.js";

const fy = process.argv[2] || fiscalYear();
console.log(`Fetching open tenders for FY ${fy} from GPP (this can take a minute)…`);
try {
  const set = await fetchLiveTenders(fy, console.log);
  saveTenders(set);
  console.log(`\nSaved ${set.items.length} open tenders to data/tenders.json`);
  for (const s of TENDER_SECTORS) {
    const n = set.items.filter((t) => t.sector === s);
    if (n.length) console.log(`  ${s.padEnd(13)} ${String(n.length).padStart(4)}  e.g. ${n[0].title.slice(0, 70)} (${n[0].entity}, closes ${n[0].closes})`);
  }
  process.exit(0);
} catch (e) {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
}
