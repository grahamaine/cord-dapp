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
import { XCHAINS, XCHAIN_FACILITATOR_URL, buyerXKey, sellerEvmPublicKey, sellerXAddress } from "../lib/chains.js";
import { evmAddressOf, verifyCrossChain } from "../lib/xchain.js";
import { privateKeyToAccount } from "viem/accounts";
import { base58 } from "@scure/base";

/** Like verifyPayee, but uses the public key from .env (the seller may not be running yet). */
async function verifyPayeeDirect(network: string, address: string) {
  return verifyCrossChain({ namespace: network, address, publicKeyHex: network.startsWith("eip155") ? sellerEvmPublicKey() : undefined });
}

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

/** Base Sepolia / Solana devnet: wallets, EURC balances, token details, facilitator, CIS-8 links. */
async function checkXChains(): Promise<boolean> {
  const buyerEvm = buyerXKey.base(), buyerSol = buyerXKey.solana();
  const sellerEvm = sellerXAddress.base(), sellerSol = sellerXAddress.solana();
  if (!buyerEvm && !buyerSol && !sellerEvm && !sellerSol) {
    console.log("\nBase / Solana settlement: off (run npm run wallets to set it up).");
    return true;
  }
  console.log(`\nBase / Solana settlement (EURC, facilitator ${XCHAIN_FACILITATOR_URL}):`);
  let good = true;
  const say = (pass: boolean, msg: string) => { console.log(`  ${pass ? "✓" : "✗"} ${msg}`); good &&= pass; };
  const rpc = async (url: string, method: string, params: unknown[]) => {
    const r: any = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) })).json();
    if (r.error) throw new Error(r.error.message);
    return r.result;
  };
  const policy = loadPolicy();
  say(policy.allowedAssets.includes("EURC"), `owner policy allows EURC${policy.allowedAssets.includes("EURC") ? "" : ` — add EURC under Policy → Allowed settlement assets (now: ${policy.allowedAssets.join(", ")})`}`);
  if (policy.approvedSuppliers.length) {
    for (const a of [sellerEvm, sellerSol].filter(Boolean))
      say(policy.approvedSuppliers.some((s) => s.account.toLowerCase() === a.toLowerCase()), `approved supplier list includes TenderScout's ${a.startsWith("0x") ? "Base" : "Solana"} address ${a} (verify it under Policy → Suppliers on other blockchains → Add)`);
  }
  try {
    const sup: any = await (await fetch(`${XCHAIN_FACILITATOR_URL}/supported`, { signal: AbortSignal.timeout(15_000) })).json();
    const nets = new Set((sup.kinds ?? []).map((k: any) => k.network));
    for (const x of Object.values(XCHAINS)) say(nets.has(x.network), `facilitator supports ${x.name} (${x.network})`);
  } catch (e) { say(false, `facilitator ${XCHAIN_FACILITATOR_URL} unreachable: ${(e as Error).message}`); }

  const ext = { maxPerLockEur: policy.maxPerLockEur };
  const due = (chain: "base" | "solana") => invoices.filter((i) => i.chain === chain && (!ext.maxPerLockEur || i.amountEur <= ext.maxPerLockEur)).reduce((t, i) => t + BigInt(i.amount), 0n);

  // Base Sepolia
  if (buyerEvm || sellerEvm) {
    const x = XCHAINS.base;
    try {
      const call = (data: string) => rpc(x.rpcUrl, "eth_call", [{ to: x.token, data }, "latest"]);
      const str = (hex: string) => { const b = Buffer.from(hex.slice(2), "hex"); const len = Number(BigInt("0x" + b.subarray(32, 64).toString("hex"))); return b.subarray(64, 64 + len).toString("utf8"); };
      const name = str(await call("0x06fdde03")), version = str(await call("0x54fd4d50"));
      say(name === x.eip712!.name && version === x.eip712!.version, `EURC on Base Sepolia: EIP-712 name "${name}", version "${version}"${name === x.eip712!.name && version === x.eip712!.version ? "" : ` — set EURC_BASE_EIP712_NAME=${name} and EURC_BASE_EIP712_VERSION=${version}`}`);
      if (buyerEvm) {
        const addr = privateKeyToAccount((buyerEvm.startsWith("0x") ? buyerEvm : `0x${buyerEvm}`) as `0x${string}`).address;
        const bal = BigInt(await call("0x70a08231" + addr.slice(2).toLowerCase().padStart(64, "0")));
        say(bal > 0n, `ProcureBot ${addr} holds ${fmtAtomic(bal, "EURC")} on Base Sepolia${bal > 0n ? "" : " — get EURC at faucet.circle.com (Base Sepolia)"}`);
        if (bal > 0n && bal < due("base")) console.log(`  ! Base invoices total ${fmtAtomic(due("base"), "EURC")}`);
      } else say(false, "BUYER_EVM_PRIVATE_KEY is empty — run npm run wallets");
    } catch (e) { say(false, `Base Sepolia RPC ${x.rpcUrl}: ${(e as Error).message}`); }
    if (sellerEvm) {
      const pub = sellerEvmPublicKey();
      say(Boolean(pub) && evmAddressOf(pub).toLowerCase() === sellerEvm.toLowerCase(), `TenderScout's Base public key ${pub ? "matches" : "is missing for"} ${sellerEvm}`);
    }
  }

  // Solana devnet
  if (buyerSol || sellerSol) {
    const x = XCHAINS.solana;
    const tokenBal = async (owner: string) => {
      const r = await rpc(x.rpcUrl, "getTokenAccountsByOwner", [owner, { mint: x.token }, { encoding: "jsonParsed" }]);
      return { accounts: r.value.length, amount: r.value.reduce((t: bigint, a: any) => t + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n) };
    };
    try {
      if (buyerSol) {
        const bytes = buyerSol.startsWith("[") ? Uint8Array.from(JSON.parse(buyerSol)) : base58.decode(buyerSol);
        const addr = base58.encode(bytes.slice(32, 64));
        const b = await tokenBal(addr);
        say(b.amount > 0n, `ProcureBot ${addr} holds ${fmtAtomic(b.amount, "EURC")} on Solana devnet${b.amount > 0n ? "" : " — get EURC at faucet.circle.com (Solana Devnet), or run npm run solana:token"}`);
        if (b.amount > 0n && b.amount < due("solana")) console.log(`  ! Solana invoices total ${fmtAtomic(due("solana"), "EURC")}`);
      } else say(false, "BUYER_SOLANA_SECRET_KEY is empty — run npm run wallets");
      if (sellerSol) {
        const b = await tokenBal(sellerSol);
        say(b.accounts > 0, `TenderScout ${sellerSol} has a EURC account on Solana devnet${b.accounts > 0 ? "" : " — run npm run solana:token (or send it EURC once from faucet.circle.com) so it can receive"}`);
      }
    } catch (e) { say(false, `Solana devnet RPC ${x.rpcUrl}: ${(e as Error).message}`); }
  }

  // CIS-8 links: can ProcureBot verify TenderScout's addresses?
  for (const [k, addr] of [["base", sellerEvm], ["solana", sellerSol]] as const) {
    if (!addr) continue;
    try {
      const v = await verifyPayeeDirect(XCHAINS[k].network, addr);
      say(v.verified, `TenderScout's ${XCHAINS[k].name} address: ${v.summary}${v.verified ? "" : ` — run npm run link-keys -- ${k}`}`);
    } catch (e) { say(false, `CIS-8 lookup for ${XCHAINS[k].name}: ${(e as Error).message}`); }
  }
  return good;
}

const ok = [
  await check("Facilitator (pays the fees)", config.facilitator.address, config.facilitator.privateKey, 1),
  await check("ProcureBot buyer (pays suppliers)", config.buyer.address, config.buyer.privateKey, 0.5),
  await checkStablecoin(),
  await checkXChains(),
].every(Boolean);
console.log(ok ? "\nAll good — payments should go through." : "\nFix the ✗ lines in .env, then restart the facilitator (and the dashboard).");
process.exit(ok ? 0 : 1);
