/**
 * Minimal client for the Concordium Agent Registry MCP server (streamable HTTP, JSON-RPC).
 * Used for lookups the REST badge-check endpoint doesn't cover, e.g. cross-chain (CIS-8) keys.
 */
import { config } from "./config.js";

const MCP_URL = process.env.REGISTRY_MCP_URL || `${config.registry.api}/mcp`;
let session: string | null | undefined;

async function rpc(body: object, sid?: string | null) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (sid) headers["mcp-session-id"] = sid;
  const res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(Number(process.env.REGISTRY_TIMEOUT_MS || 30_000)) });
  const text = await res.text();
  return { res, json: text.includes("{") ? JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) : null };
}

async function ensureSession() {
  if (session !== undefined) return session;
  const { res } = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "cord", version: "0.1" } } });
  session = res.headers.get("mcp-session-id");
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
  return session;
}

/** Call a registry tool and return its parsed JSON result (or null). */
export async function registryTool<T = any>(name: string, args: Record<string, unknown>): Promise<T | null> {
  const sid = await ensureSession();
  let { json } = await rpc({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: { network: config.registry.network, ...args } } }, sid);
  if (json?.error?.code === -32001 || /session/i.test(json?.error?.message ?? "")) {
    session = undefined; // session expired: start a new one and retry once
    ({ json } = await rpc({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: { network: config.registry.network, ...args } } }, await ensureSession()));
  }
  if (json?.error) throw new Error(`registry ${name}: ${json.error.message}`);
  const text = json?.result?.content?.[0]?.text;
  if (json?.result?.isError) throw new Error(`registry ${name}: ${text}`);
  if (!text || text === "null") return null;
  try { return JSON.parse(text); } catch { return text as T; }
}
