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
const TTL_MS = 60_000;

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
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;

  const { status, body } = await getJson(`/v1/badge-check/${encodeURIComponent(id)}`);
  let v: BadgeVerdict;
  if (status !== 200) {
    v = { verified: false, subject: id, agents: 0, issues: [`registry returned HTTP ${status}`, body?.error].filter(Boolean), raw: body };
  } else if (typeof body.badge_valid === "boolean") {
    // single-badge form
    v = { verified: body.badge_valid, subject: id, agents: body.badge_valid ? 1 : 0, issues: body.issues ?? [], raw: body };
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
