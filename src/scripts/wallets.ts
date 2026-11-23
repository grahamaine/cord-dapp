/**
 * npm run wallets — creates the test wallets Kakasa needs on Base Sepolia and Solana devnet, and adds
 * them to .env. Existing keys are never replaced. Secret keys are written to .env only, never printed.
 *
 *   ProcureBot (pays)        BUYER_EVM_PRIVATE_KEY, BUYER_SOLANA_SECRET_KEY
 *   TenderScout (gets paid)  SELLER_EVM_ADDRESS + SELLER_EVM_PUBLIC_KEY (+ SELLER_EVM_PRIVATE_KEY, only used
 *                            once to prove the key for the CIS-8 link), SELLER_SOLANA_ADDRESS (+ SELLER_SOLANA_SECRET_KEY)
 *
 * Neither agent needs ETH or SOL: the public x402 facilitator pays the network fees.
 */
import "dotenv/config";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { bytesToHex } from "@noble/hashes/utils";
import { keccak_256 } from "@noble/hashes/sha3";
import { evmAddressOf } from "../lib/xchain.js";
import { XCHAINS } from "../lib/chains.js";

const ENV = ".env";
const current = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
const has = (k: string) => new RegExp(`^${k}=\\S+`, "m").test(current) || Boolean(process.env[k]);
const lines: string[] = [];
const set = (k: string, v: string) => { if (!has(k)) { lines.push(`${k}=${v}`); process.env[k] = v; } };

function evm() {
  const priv = secp256k1.utils.randomPrivateKey();
  const pub = secp256k1.getPublicKey(priv, false);
  return { priv: "0x" + bytesToHex(priv), pubHex: bytesToHex(pub), address: checksum(evmAddressOf(bytesToHex(pub))) };
}
function sol() {
  const seed = randomBytes(32);
  const pub = ed25519.getPublicKey(seed);
  const secret = new Uint8Array(64);
  secret.set(seed, 0);
  secret.set(pub, 32);
  return { secret: base58.encode(secret), address: base58.encode(pub) };
}
/** EIP-55 checksum, so the address matches what explorers and wallets show. */
function checksum(addr: string) {
  const lower = addr.toLowerCase().replace(/^0x/, "");
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  return "0x" + [...lower].map((c, i) => (parseInt(hash[i], 16) >= 8 ? c.toUpperCase() : c)).join("");
}

if (!has("BUYER_EVM_PRIVATE_KEY")) set("BUYER_EVM_PRIVATE_KEY", evm().priv);
if (!has("BUYER_SOLANA_SECRET_KEY")) set("BUYER_SOLANA_SECRET_KEY", sol().secret);
if (!has("SELLER_EVM_ADDRESS")) {
  const k = evm();
  set("SELLER_EVM_PRIVATE_KEY", k.priv);
  set("SELLER_EVM_PUBLIC_KEY", k.pubHex);
  set("SELLER_EVM_ADDRESS", k.address);
}
if (!has("SELLER_SOLANA_ADDRESS")) {
  const k = sol();
  set("SELLER_SOLANA_SECRET_KEY", k.secret);
  set("SELLER_SOLANA_ADDRESS", k.address);
}

if (lines.length) {
  appendFileSync(ENV, `${current.endsWith("\n") || !current ? "" : "\n"}\n# ---- Base Sepolia / Solana devnet test wallets (npm run wallets, ${new Date().toISOString().slice(0, 10)}) ----\n${lines.join("\n")}\n`);
  console.log(`Added ${lines.length} entries to .env (secret keys are in .env only).\n`);
} else {
  console.log("All Base / Solana wallets already exist in .env; nothing changed.\n");
}

// Addresses only — never print a secret.
const buyerEvm = (() => { const k = process.env.BUYER_EVM_PRIVATE_KEY!.replace(/^0x/, ""); return checksum(evmAddressOf(bytesToHex(secp256k1.getPublicKey(k, false)))); })();
const buyerSol = (() => { const s = process.env.BUYER_SOLANA_SECRET_KEY!.trim(); const b = s.startsWith("[") ? Uint8Array.from(JSON.parse(s)) : base58.decode(s); return base58.encode(b.slice(32, 64)); })();

console.log("ProcureBot (pays):");
console.log(`  Base Sepolia   ${buyerEvm}`);
console.log(`  Solana devnet  ${buyerSol}`);
console.log("TenderScout (gets paid):");
console.log(`  Base Sepolia   ${process.env.SELLER_EVM_ADDRESS}`);
console.log(`  Solana devnet  ${process.env.SELLER_SOLANA_ADDRESS}`);
console.log(`
Next:
 1. Get test EURC at https://faucet.circle.com (10 EURC per request, once a day per chain):
      - EURC on Base Sepolia  -> ProcureBot's Base address above
      - EURC on Solana Devnet -> ProcureBot's Solana address above
      - EURC on Solana Devnet -> TenderScout's Solana address too (this creates its EURC account, which
        Solana needs before it can receive; do it the next day if the faucet limit is reached)
 2. Link TenderScout's keys to its Concordium owner (CIS-8):  npm run link-keys -- base   and   npm run link-keys -- solana
 3. npm run doctor, then restart the seller and the dashboard.
Tokens: EURC ${XCHAINS.base.token} (Base Sepolia), mint ${XCHAINS.solana.token} (Solana devnet).`);
