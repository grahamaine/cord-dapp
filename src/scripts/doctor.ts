/**
 * npm run doctor — checks the accounts in .env against Concordium testnet, without printing keys:
 *   - does each private key belong to its account? (compares the derived public key with the keys on-chain)
 *   - how much CCD does each account hold?
 * A sponsored payment fails with "Verification failed" if the facilitator key doesn't match its account,
 * or if the facilitator has no CCD to pay the fee.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { AccountAddress, CcdAmount } from "@concordium/web-sdk";
import { ConcordiumGRPCNodeClient } from "@concordium/web-sdk/nodejs";
import { credentials } from "@grpc/grpc-js";
import { config } from "../lib/config.js";

const client = new ConcordiumGRPCNodeClient(config.grpc.host, config.grpc.port, credentials.createSsl(), { timeout: 15_000 });

function pubFrom(pk: string) {
  const hex = pk.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`private key should be 64 hex characters (got ${hex.length})`);
  return Buffer.from(ed25519.getPublicKey(Buffer.from(hex, "hex"))).toString("hex");
}

async function check(label: string, address: () => string, key: () => string, needCcd: number) {
  let addr = "", pk = "";
  try { addr = address(); } catch { console.log(`✗ ${label}: address missing in .env`); return false; }
  try { pk = key(); } catch { console.log(`✗ ${label}: private key missing in .env`); return false; }
  try {
    const info: any = await client.getAccountInfo(AccountAddress.fromBase58(addr.trim()));
    const onChain = JSON.stringify(info.accountCredentials, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).toLowerCase();
    const pub = pubFrom(pk);
    const match = onChain.includes(pub.toLowerCase());
    const ccd = Number(CcdAmount.toCcd(info.accountAmount));
    console.log(`${match ? "✓" : "✗"} ${label} ${addr.slice(0, 6)}…: key ${match ? "matches this account" : "does NOT belong to this account — export the key of exactly this account from the wallet"}`);
    console.log(`  ${ccd >= needCcd ? "✓" : "✗"} balance ${ccd} CCD${ccd < needCcd ? ` — needs at least ${needCcd}; use the testnet faucet` : ""}`);
    return match && ccd >= needCcd;
  } catch (e) {
    console.log(`✗ ${label} ${addr.slice(0, 6)}…: ${(e as Error).message}`);
    return false;
  }
}

const ok = [
  await check("Facilitator (pays the fees)", config.facilitator.address, config.facilitator.privateKey, 1),
  await check("ProcureBot buyer (pays suppliers)", config.buyer.address, config.buyer.privateKey, 0.5),
].every(Boolean);
console.log(ok ? "\nAll good — payments should go through." : "\nFix the ✗ lines in .env, then restart the facilitator (and the dashboard).");
process.exit(ok ? 0 : 1);
