/**
 * Hash-chained audit log of every lock operation and owner action (create, fund, send,
 * release, cancel, policy change, pause/resume). Each entry records who acted (owner or
 * agent), what happened, the outcome and the reason. Editing or deleting a line breaks the
 * chain. Supports EU AI Act Art. 12 (automatic event logging) and Art. 26(6) (deployers keep
 * logs for at least six months).
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type Actor = "owner" | "agent" | "system";
export interface AuditInput {
  actor: Actor;
  op: string; // create | fund | send | release | cancel | policy | pause | resume | refused
  lockId?: string;
  outcome: "ok" | "refused" | "error";
  detail: string;
  data?: Record<string, unknown>;
}
export interface AuditEntry extends AuditInput {
  seq: number;
  ts: string;
  prevHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);
const auditPath = () => process.env.AUDIT_PATH || (process.env.VERCEL ? "/tmp/audit.jsonl" : "data/audit.jsonl");
const digest = (e: Omit<AuditEntry, "hash">) => createHash("sha256").update(JSON.stringify(e)).digest("hex");

export function readAudit(): AuditEntry[] {
  const p = auditPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function audit(input: AuditInput): AuditEntry {
  const p = auditPath();
  mkdirSync(dirname(p), { recursive: true });
  const last = readAudit().at(-1);
  const base = { ...input, seq: (last?.seq ?? 0) + 1, ts: new Date().toISOString(), prevHash: last?.hash ?? GENESIS };
  const entry: AuditEntry = { ...base, hash: digest(base) };
  appendFileSync(p, JSON.stringify(entry) + "\n");
  return entry;
}

export function verifyAudit(): { ok: boolean; count: number; brokenAt?: number } {
  return verifyAuditEntries(readAudit());
}

/** Check a list of audit entries (e.g. a published snapshot) without touching the file. */
export function verifyAuditEntries(all: AuditEntry[]): { ok: boolean; count: number; brokenAt?: number } {
  let prev = GENESIS;
  for (const e of all) {
    const { hash, ...rest } = e;
    if (e.prevHash !== prev || digest(rest) !== hash) return { ok: false, count: all.length, brokenAt: e.seq };
    prev = hash;
  }
  return { ok: true, count: all.length };
}
