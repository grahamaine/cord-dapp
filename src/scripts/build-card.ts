/**
 * Build an Agent Card (ERC-8004 registration file + A2A v1.0 card, with the
 * Verified by Concordium badge extension) and print its SHA-256 for on-chain anchoring.
 *   npm run card -- seller
 * Then: host data/agent-card.seller.json at SELLER_URL/.well-known/agent-card.json,
 * and register / set_agent_uri in the Agent Registry app with that URL + hash.
 * After registration, put the token id + badge in .env and re-run to embed them.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { config } from "../lib/config.js";

const who = (process.argv[2] ?? "seller") as "seller" | "buyer";
const chain = config.network; // CAIP-2, e.g. ccd:4221332d34e1694168c2a0c0b3fd0f27
const registry = process.env.REGISTRY_CONTRACT ?? ""; // "<index>.<subindex>" of the testnet CIS-8004 contract
const cis8 = process.env.CIS8_CONTRACT ?? "";
const tokenId = process.env[who === "seller" ? "SELLER_TOKEN_ID" : "BUYER_TOKEN_ID"];
const badge = who === "seller" ? config.seller.badge : config.buyer.badge;
const owner = process.env[who === "seller" ? "SELLER_OWNER" : "BUYER_OWNER"] ?? "";
// Cards must use PUBLIC URLs (the registry and other agents fetch them), never localhost.
const publicUrl = (process.env.PUBLIC_URL || "https://cord-dapp.vercel.app").replace(/\/$/, "");
const base = who === "seller" ? publicUrl : `${publicUrl}/procurebot`;

const profile = who === "seller"
  ? { name: "TenderScout", description: "Supplier-side agent for Ugandan businesses: collects supplier invoice payments and sells tender notices and price benchmarks to Verified by Concordium agents, per call, over x402 on Concordium.",
      skills: [
        { id: "tenders", name: "Open tenders", description: "Open public tenders filtered by sector.", tags: ["procurement", "tenders", "uganda"] },
        { id: "price-benchmark", name: "Price benchmark", description: "Low/median/high supplier prices for an item.", tags: ["procurement", "pricing"] },
        { id: "invoice-payment", name: "Invoice payment", description: "Settle a supplier invoice by id, paid over x402.", tags: ["payments", "invoices", "uganda"] },
      ] }
  : { name: "ProcureBot", description: "Hotel purchasing agent (Entebbe, Uganda) that pays supplier invoices and buys procurement data only from Verified by Concordium agents, within owner-set spending limits, with an auditable receipt trail.",
      skills: [{ id: "purchase", name: "Purchase data", description: "Buys data from verified agents over x402.", tags: ["procurement", "buyer"] }] };

const card = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: profile.name,
  description: profile.description,
  image: `${base}/icon.png`,
  version: "0.1.0",
  provider: { organization: "Cord", url: "https://github.com/grahamaine" },
  supportedInterfaces: [{ url: `${base}/a2a/v1`, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }],
  capabilities: {
    streaming: false,
    pushNotifications: false,
    extensions: badge && registry ? [{
      uri: "https://docs.concordium.com/a2a-extensions/concordium-badge/v1",
      description: "Verified by Concordium badge — on-chain agent identity in a CIS-8004 registry",
      required: false,
      params: {
        tokenAddress: `${chain}/cis-2:${badge}`,
        owner: { account: `${chain}:${owner}` },
        contracts: { cis8004: `${chain}:${registry}`, ...(cis8 ? { cis8: `${chain}:${cis8}` } : {}) },
        verify: "Resolve tokenAddress via CIS-8004 agent_of; confirm owner + status is Active + card SHA-256 equals metadata_hash.",
        verification: {
          service: "Concordium Agent Registry",
          verifyUrl: `${config.registry.api}/v1/badge-check/${badge}?network=${config.registry.network}`,
          mcp: `${config.registry.api}/mcp`,
          docs: "https://docs.concordium.com/en/mainnet/technical-reference/agent-registry/concordium-badge.html",
        },
      },
    }] : [],
  },
  defaultInputModes: ["application/json"],
  defaultOutputModes: ["application/json"],
  skills: profile.skills,
  services: [{ name: "A2A", endpoint: `${base}/.well-known/agent-card.json`, version: "1.0" }],
  x402Support: who === "seller",
  active: true,
  registrations: tokenId && registry ? [{ agentId: Number(tokenId), agentRegistry: `${chain}:${registry}` }] : [],
};

const bytes = JSON.stringify(card, null, 2);
mkdirSync("data", { recursive: true });
const path = `data/agent-card.${who}.json`;
writeFileSync(path, bytes);
console.log(`wrote ${path}`);
console.log(`agent URI ${base}/.well-known/agent-card.json`);
console.log(`sha256 ${createHash("sha256").update(bytes).digest("hex")}`);
if (!badge) console.log("note: no badge yet — register the agent, set the badge/token id in .env, and re-run.");
