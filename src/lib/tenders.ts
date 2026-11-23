/**
 * Live public tenders from Uganda's Government Procurement Portal (GPP, run by PPDA), via its official
 * OCDS open data service (the same source the Open Contracting Partnership's data registry uses):
 *
 *   POST https://cdn.ppda.go.ug/api/open-data/v2/ocds/exports  {"fy":"2026-2027","format":"json"}
 *     → { success, job_id, status_url }
 *   GET status_url → { status: queued | processing | complete, download_url }
 *   GET download_url → OCDS release package for that fiscal year (1 July – 30 June)
 *
 * TenderScout keeps the open tenders (status active, bid deadline still ahead), sorts them into sectors,
 * and caches them in data/tenders.json. `npm run tenders` refreshes that file by hand; the seller also
 * refreshes it in the background every TENDERS_REFRESH_HOURS (default 6). If GPP can't be reached the last
 * good copy is served, and the response says when it was fetched.
 * Licence: GPP open data, Open Data Commons Attribution (ODC-By) — attribute PPDA / GPP.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Tender {
  id: string;
  ocid: string;
  entity: string;
  sector: string;
  title: string;
  method: string;
  closes: string; // YYYY-MM-DD
  currency: string;
  estimate: number | null;
}
export interface TenderSet {
  source: string;
  fiscalYear: string;
  fetchedAt: string;
  live: boolean;
  items: Tender[];
}

export const TENDER_SECTORS = ["hospitality", "food", "health", "it", "construction", "security", "transport", "education", "supplies", "services"] as const;

const API = process.env.GPP_OCDS_API || "https://cdn.ppda.go.ug/api/open-data/v2/ocds/";
const CACHE = process.env.TENDERS_PATH || (process.env.VERCEL ? "data/tenders.json" : "data/tenders.json");
const REFRESH_MS = Number(process.env.TENDERS_REFRESH_HOURS || 6) * 3600_000;
export const TENDER_SOURCE = "Uganda Government Procurement Portal (GPP, PPDA) open data, OCDS, ODC-By";

/** Fiscal year that contains `d` (Uganda: 1 July – 30 June). */
export function fiscalYear(d = new Date()) {
  const y = d.getUTCFullYear(), start = d.getUTCMonth() >= 6 ? y : y - 1;
  return `${start}-${start + 1}`;
}

// Order matters: the first matching sector wins.
const RULES: [string, RegExp][] = [
  ["hospitality", /\b(hotel|accommodation|catering|canteen|meals?|lunch|refreshments?|laundry|linen|towel|bedding|conference facilit|venue|cleaning|janitorial|housekeeping)\b/i],
  ["food", /\b(food|foodstuffs?|produce|vegetables?|fruits?|rice|maize|beans|sugar|milk|meat|cooking oil|groceries|rations)\b/i],
  ["health", /\b(medical|medicines?|drugs?|pharmac|hospital|clinic|health|laboratory|reagents?|diagnostic|surgical)\b/i],
  ["it", /\b(ict|computers?|laptops?|software|internet|network(ing)?|wi-?fi|servers?|cctv|printers?|website|system|digital|data cent)/i],
  ["construction", /\b(construction|rehabilitation|renovation|civil works|road|bridge|building|borehole|drainage|roofing|works)\b/i],
  ["security", /\b(security|guard(ing)?|fire|alarm)\b/i],
  ["transport", /\b(vehicles?|motor ?cycles?|transport|fuel|lubricants|tyres?|car hire|fleet|bus)\b/i],
  ["education", /\b(school|schools|education|teaching|scholastic|textbooks?|instructional|training)\b/i],
];
export function sectorOf(title: string, category?: string): string {
  for (const [s, re] of RULES) if (re.test(title)) return s;
  return category === "goods" ? "supplies" : "services";
}

/** OCDS release package → open tenders. */
export function openTenders(pkg: any, now = new Date()): Tender[] {
  const releases: any[] = pkg?.releases ?? (Array.isArray(pkg) ? pkg : []);
  const latest = new Map<string, any>(); // one row per contracting process: keep its newest release
  for (const r of releases) {
    const prev = latest.get(r.ocid);
    if (!prev || String(r.date ?? "") >= String(prev.date ?? "")) latest.set(r.ocid, r);
  }
  const today = now.toISOString().slice(0, 10);
  const out: Tender[] = [];
  for (const r of latest.values()) {
    const t = r.tender;
    if (!t) continue;
    const closes = String(t.tenderPeriod?.endDate ?? "").slice(0, 10);
    if (!closes || closes < today) continue;
    if (t.status && !["active", "planned", "planning"].includes(String(t.status))) continue;
    if (r.awards?.length) continue;
    const buyer = r.buyer?.name ?? (r.parties ?? []).find((p: any) => (p.roles ?? []).includes("buyer") || (p.roles ?? []).includes("procuringEntity"))?.name ?? "Unknown entity";
    const title = String(t.title ?? t.description ?? "").replace(/\s+/g, " ").trim();
    if (!title) continue;
    out.push({
      id: String(t.id ?? r.ocid),
      ocid: String(r.ocid),
      entity: String(buyer),
      sector: sectorOf(title, t.mainProcurementCategory),
      title,
      method: String(t.procurementMethodDetails ?? t.procurementMethod ?? ""),
      closes,
      currency: String(t.value?.currency ?? "UGX"),
      estimate: typeof t.value?.amount === "number" ? t.value.amount : t.value?.amount ? Number(t.value.amount) : null,
    });
  }
  return out.sort((a, b) => a.closes.localeCompare(b.closes));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function getJson(url: string, init?: RequestInit) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** Ask GPP for the fiscal year's export, wait for it, download it, keep the open tenders. */
export async function fetchLiveTenders(fy = fiscalYear(), log: (m: string) => void = () => {}): Promise<TenderSet> {
  const job: any = await getJson(`${API}exports`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fy, format: "json" }) });
  if (!job?.success || !job.status_url) throw new Error(`GPP export not started: ${JSON.stringify(job).slice(0, 200)}`);
  log(`GPP export job ${job.job_id} for FY ${fy} started`);
  let st: any;
  for (let i = 0; i < 40; i++) {
    await sleep(i === 0 ? 3000 : 6000);
    st = await getJson(job.status_url);
    if (st.status === "complete") break;
    if (st.status !== "queued" && st.status !== "processing") throw new Error(`GPP export failed: ${JSON.stringify(st).slice(0, 200)}`);
    log(`  …${st.status}`);
  }
  if (st?.status !== "complete" || !st.download_url) throw new Error("GPP export didn't finish in 4 minutes; try again later");
  const pkg = await getJson(st.download_url);
  const items = openTenders(pkg);
  return { source: TENDER_SOURCE, fiscalYear: fy, fetchedAt: new Date().toISOString(), live: true, items };
}

export function readCachedTenders(): TenderSet | null {
  if (!existsSync(CACHE)) return null;
  try { return JSON.parse(readFileSync(CACHE, "utf8")); } catch { return null; }
}
export function saveTenders(set: TenderSet) {
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, JSON.stringify(set, null, 1) + "\n");
}

let refreshing: Promise<void> | null = null;
/**
 * Current tender list: the cached live copy (refreshed in the background when stale), else `fallback`.
 * Never waits for GPP, so a paid request is always answered quickly.
 */
export function currentTenders(fallback: Tender[]): TenderSet {
  const cached = readCachedTenders();
  const stale = !cached || Date.now() - Date.parse(cached.fetchedAt) > REFRESH_MS;
  if (stale && !refreshing && !process.env.VERCEL && process.env.TENDERS_LIVE !== "false") {
    refreshing = fetchLiveTenders()
      .then((set) => { saveTenders(set); console.log(`[tenders] ${set.items.length} open tenders from GPP (FY ${set.fiscalYear})`); })
      .catch((e) => console.warn(`[tenders] GPP refresh failed, keeping ${cached ? "the last copy" : "sample data"}: ${(e as Error).message}`))
      .finally(() => { refreshing = null; });
  }
  // Drop tenders whose deadline has passed since the copy was fetched.
  if (cached) {
    const today = new Date().toISOString().slice(0, 10);
    return { ...cached, items: cached.items.filter((t) => t.closes >= today) };
  }
  return { source: "TenderScout sample data (GPP not fetched yet; run npm run tenders)", fiscalYear: fiscalYear(), fetchedAt: "", live: false, items: fallback };
}
