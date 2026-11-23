/**
 * npm run publish:judge — publish a read-only snapshot of Cord's records for the hosted judge view.
 *
 * Copies the audit log, receipts, anchors, locks and spending limits into judge/snapshot.json (no private keys,
 * nothing that can spend), then commits and pushes it so Vercel redeploys cord-dapp.vercel.app/judge.
 * The judge page re-checks every hash chain and confirms the anchors and payments on Concordium itself,
 * so the snapshot can't be edited without it showing.
 *
 *   npm run publish:judge             write + commit + push
 *   npm run publish:judge -- --no-push   write only
 */
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { config } from "../lib/config.js";
import { readAudit, verifyAudit } from "../lib/audit.js";
import { readReceipts, verifyChain } from "../lib/receipts.js";
import { readAnchors } from "../lib/anchor.js";
import { readLocks } from "../lib/locks.js";
import { loadPolicy } from "../lib/policy.js";

const audit = verifyAudit(), receipts = verifyChain();
if (!audit.ok) throw new Error(`audit log is broken at #${audit.brokenAt}; not publishing`);
if (!receipts.ok) throw new Error(`receipt chain is broken at #${receipts.brokenAt}; not publishing`);

const policy = loadPolicy();
const opt = (f: () => string) => { try { return f(); } catch { return ""; } };
const snapshot = {
  kind: "cord-judge-snapshot",
  version: 1,
  publishedAt: new Date().toISOString(),
  network: config.network,
  accounts: {
    procurebot: opt(config.buyer.address),
    facilitator: opt(config.facilitator.address),
    supplier: process.env.SELLER_PAY_TO || "",
  },
  badges: { procurebot: config.buyer.badge || "", supplier: process.env.SELLER_BADGE || "" },
  policy: {
    maxPerLockEur: policy.maxPerLockEur, dailyLimitEur: policy.dailyLimitEur, requireSellerBadge: policy.requireSellerBadge,
    requireHumanRelease: policy.requireHumanRelease, requireOwnerSignature: policy.requireOwnerSignature, paused: policy.paused,
  },
  locks: readLocks(),
  audit: readAudit(),
  receipts: readReceipts(),
  anchors: readAnchors(),
};
mkdirSync("judge", { recursive: true });
writeFileSync("judge/snapshot.json", JSON.stringify(snapshot, null, 1) + "\n");
console.log(`Wrote judge/snapshot.json: ${snapshot.audit.length} audit entries, ${snapshot.receipts.length} receipts, ${snapshot.anchors.length} anchors, ${snapshot.locks.length} locks.`);
if (!snapshot.anchors.length) console.log("Tip: press Anchor now in the dashboard first, so judges can verify the log on-chain.");
else if (snapshot.anchors.at(-1)!.auditSeq < snapshot.audit.at(-1)!.seq) console.log(`Note: entries after #${snapshot.anchors.at(-1)!.auditSeq} aren't anchored yet; press Anchor now and publish again to cover them.`);

if (!process.argv.includes("--no-push")) {
  const git = (...a: string[]) => execFileSync("git", a, { stdio: "inherit" });
  git("add", "judge/snapshot.json");
  // the live tender list (npm run tenders), so the Vercel copy of TenderScout sells the same tenders
  if (existsSync("data/tenders.json")) git("add", "data/tenders.json");
  try { git("commit", "-m", `Judge view snapshot ${snapshot.publishedAt}`); } catch { console.log("Nothing new to commit."); }
  git("push");
  console.log("Pushed. Vercel redeploys in about a minute: https://cord-dapp.vercel.app/judge");
}
