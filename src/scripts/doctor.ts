/**
 * npm run doctor — checks the accounts in .env against Concordium testnet, without printing keys:
 *   - does each private key belong to its account? (compares the derived public key with the keys on-chain)
 *   - how much CCD does each account hold?
 *   - stablecoin mode (INVOICE_ASSET=EURR etc.): which tokens exist on the network, does the invoice token
 *     exist with the decimals in .env, does ProcureBot hold enough of it, is it in the owner's allowed assets?
 * A sponsored payment fails with "Verification failed" if the facilitator key doesn't match its account,
 * or if the facilitator has no CCD to pay the fee.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { AccountAddress, CcdAmount } from "@concordium/web-sdk";
import { ConcordiumGRPCNodeClient } from "@concordium/web-sdk/nodejs";
import { credentials } from "@grpc/grpc-js";
import { config } from "../lib/config.js";
import { INVOICE_ASSET, assetSpec, fmtAtomic, isCcd, unpriceable } from "../lib/eur.js";
import { tokenBalances, tokenDecimals, tokenList } from "../lib/plt.js";
import { loadPolicy } from "../lib/policy.js";
import { invoices } from "../seller/data.js";

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

async function checkStablecoin(): Promise<boolean> {
  try {
    const list = await tokenList();
    console.log(`\nStablecoins (PLTs) on this network: ${list.length ? list.join(", ") : "none"}`);
  } catch (e) {
    console.log(`\n? couldn't list the network's tokens: ${(e as Error).message}`);
  }
  if (isCcd(INVOICE_ASSET)) {
    console.log("  Invoices settle in CCD at the demo rate. Set INVOICE_ASSET=EURR (or another token above) to pay at full value.");
    return true;
  }
  console.log(`Invoices settle in ${INVOICE_ASSET} at full value.`);
  let good = true;
  const say = (pass: boolean, msg: string) => { console.log(`  ${pass ? "✓" : "✗"} ${msg}`); good &&= pass; };
  const onChainDec = await tokenDecimals(INVOICE_ASSET);
  if (onChainDec === undefined) { say(false, `${INVOICE_ASSET} doesn't exist on this network — pick one from the list above, or request a test token from Concordium`); return false; }
  const spec = assetSpec(INVOICE_ASSET);
  say(onChainDec === spec.decimals, `decimals: ${onChainDec} on-chain${onChainDec === spec.decimals ? "" : `, but .env says ${spec.decimals} — set INVOICE_ASSET_DECIMALS=${onChainDec}`}`);
  const noRate = unpriceable(INVOICE_ASSET);
  say(!noRate, noRate ?? `EUR rate: 1 ${INVOICE_ASSET} = €${spec.eurPerToken}`);
  const policy = loadPolicy();
  say(policy.allowedAssets.includes(INVOICE_ASSET), `owner policy allows ${INVOICE_ASSET}${policy.allowedAssets.includes(INVOICE_ASSET) ? "" : ` — add it under Policy → Allowed settlement assets (now: ${policy.allowedAssets.join(", ")})`}`);
  const due = invoices.filter((i) => i.amountEur <= policy.maxPerLockEur || !policy.maxPerLockEur).reduce((s, i) => s + BigInt(i.amount), 0n);
  try {
    const held = (await tokenBalances(config.buyer.address())).find((t) => t.asset.toUpperCase() === INVOICE_ASSET.toUpperCase());
    const amt = BigInt(held?.amount ?? "0");
    say(amt > 0n, `ProcureBot holds ${fmtAtomic(amt, INVOICE_ASSET)}${amt > 0n ? "" : " — get test tokens from the issuer (the token's governance account can mint and send them)"}`);
    if (amt > 0n && amt < due) console.log(`  ! open invoices within the cap total ${fmtAtomic(due, INVOICE_ASSET)}; some payments will fail until ProcureBot holds more`);
  } catch (e) { say(false, `couldn't read ProcureBot's token balance: ${(e as Error).message}`); }
  console.log("  Note: if the token uses an allow list, both ProcureBot and TenderScout must be on it.");
  return good;
}

const ok = [
  await check("Facilitator (pays the fees)", config.facilitator.address, config.facilitator.privateKey, 1),
  await check("ProcureBot buyer (pays suppliers)", config.buyer.address, config.buyer.privateKey, 0.5),
  await checkStablecoin(),
].every(Boolean);
console.log(ok ? "\nAll good — payments should go through." : "\nFix the ✗ lines in .env, then restart the facilitator (and the dashboard).");
process.exit(ok ? 0 : 1);
