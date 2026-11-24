/**
 * Verified by Concordium badge checks, via the Agent Registry REST API
 * (https://agent-registry-mcp.concordium.com/docs). A passing check means the agent is
 * registered in the CIS-8004 registry, is Active, is owned by an identity-verified
 * Concordium account, and its published Agent Card matches the on-chain hash.
 */
import { config } from "./config.js";

export interface BadgeVerdict {
  verified: boolean;
  subject: string; // badge token address or account address that was checked
  agents: number; // for account checks: how many valid badged agents the account owns
  issues: string[];
  raw: unknown;
}

const cache = new Map<string, { at: number; v: BadgeVerdict }>();
/** A verified answer is reused for CHECK_CACHE_MS (default 10 min); a failed one only for 30 s, so a network blip is retried soon. */
const TTL_MS = Number(process.env.CHECK_CACHE_MS || 600_000);
const FAIL_TTL_MS = 30_000;
const inflight = new Map<string, Promise<BadgeVerdict>>();
const fresh = (h: { at: number; v: BadgeVerdict } | undefined) => h && Date.now() - h.at < (h.v.verified ? TTL_MS : FAIL_TTL_MS);

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const url = `${config.registry.api}${path}${path.includes("?") ? "&" : "?"}network=${config.registry.network}`;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(Number(process.env.REGISTRY_TIMEOUT_MS || 30_000)) });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } catch (e) {
    // registry unreachable: fail closed (treated as unverified)
    return { status: 0, body: { error: `registry unreachable: ${(e as Error).message}` } };
  }
}

/** Check one badge (token address) or an account (all agents it owns). */
export async function checkBadge(id: string): Promise<BadgeVerdict> {
  const hit = cache.get(id);
  if (fresh(hit)) return hit!.v;
  // One registry call per id at a time: parallel callers share it.
  if (!inflight.has(id)) inflight.set(id, lookupBadge(id).finally(() => inflight.delete(id)));
  return inflight.get(id)!;
}

/**
 * For screens, not for payments: the last answer straight away (refreshed in the background when old),
 * or, with none yet, wait at most waitMs and otherwise report "still checking".
 */
export async function checkBadgeQuick(id: string, waitMs = 3000): Promise<BadgeVerdict> {
  const hit = cache.get(id);
  if (hit) { if (!fresh(hit)) checkBadge(id).catch(() => {}); return hit.v; }
  const pending: BadgeVerdict = { verified: false, subject: id, agents: 0, issues: ["still checking with the registry"], raw: null };
  return Promise.race([checkBadge(id), new Promise<BadgeVerdict>((r) => setTimeout(() => r(pending), waitMs))]);
}

async function lookupBadge(id: string): Promise<BadgeVerdict> {

  const { status, body } = await getJson(`/v1/badge-check/${encodeURIComponent(id)}`);
  let v: BadgeVerdict;
  if (status !== 200) {
    v = { verified: false, subject: id, agents: 0, issues: [`registry returned HTTP ${status}`, body?.error].filter(Boolean), raw: body };
  } else if (typeof body.badge_valid === "boolean") {
    // single-badge form
    v = { verified: body.badge_valid, subject: id, agents: body.badge_valid ? 1 : 0, issues: (body.issues ?? []).map((i: any) => (typeof i === "string" ? i : i?.message ?? JSON.stringify(i))), raw: body };
  } else {
    // account form: { agent_count, summary: { valid, invalid }, agents }
    const valid = Number(body?.summary?.valid ?? 0);
    v = { verified: valid > 0, subject: id, agents: valid, issues: valid > 0 ? [] : ["account owns no valid badged agent"], raw: body };
  }
  cache.set(id, { at: Date.now(), v });
  return v;
}

/** Full badge JSON (owner, status, agent_uri, wallet) for display and receipts. */
export async function getBadgeJson(tokenAddress: string) {
  const { status, body } = await getJson(`/v1/get-badge-JSON/${encodeURIComponent(tokenAddress)}`);
  if (status !== 200) throw new Error(`badge ${tokenAddress}: HTTP ${status} ${body?.error ?? ""}`);
  return body as { token_address: string; token_id: number; status: string; owner_account: string; agent_uri?: string | null; agent_wallet?: string };
}

/** Agent Card hash check: on-chain metadata_hash vs SHA-256 of the hosted card. */
export async function verifyAgentCard(tokenAddress: string) {
  const { body } = await getJson(`/v1/verify-agent-card/${encodeURIComponent(tokenAddress)}`);
  return body as { match: boolean | null; [k: string]: unknown };
}
