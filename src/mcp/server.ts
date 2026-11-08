/**
 * MCP server exposing ProcureBot to any LLM agent (Claude Desktop, Cursor, etc).
 * The LLM decides WHAT to buy; Cord enforces WHO it may pay, HOW MUCH, and logs it.
 * Add to Claude Desktop config: { "command": "npx", "args": ["tsx", "<repo>/src/mcp/server.ts"] }
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "../lib/config.js";
import { checkBadge } from "../lib/badge.js";
import { readReceipts, verifyChain } from "../lib/receipts.js";
import { buy } from "../buyer/procurebot.js";

const server = new McpServer({ name: "cord-procurebot", version: "0.1.0" });
const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

server.tool("find_tenders", "Buy the list of open tenders for a sector from TenderScout (paid, x402)",
  { sector: z.string().optional(), purpose: z.string().describe("why you are buying this, recorded in the audit log") },
  async ({ sector, purpose }) => text(await buy(`${config.seller.url}/tenders${sector ? `?sector=${encodeURIComponent(sector)}` : ""}`, purpose)));

server.tool("price_benchmark", "Buy a supplier price benchmark for an item (paid, x402)",
  { item: z.string(), purpose: z.string() },
  async ({ item, purpose }) => text(await buy(`${config.seller.url}/price-benchmark?item=${encodeURIComponent(item)}`, purpose)));

server.tool("check_agent", "Check whether an agent badge or account is Verified by Concordium",
  { id: z.string() }, async ({ id }) => text(await checkBadge(id)));

server.tool("audit_log", "Return the tamper-evident receipt log and whether its hash chain is intact", {},
  async () => text({ chain: verifyChain(), receipts: readReceipts() }));

await server.connect(new StdioServerTransport());
