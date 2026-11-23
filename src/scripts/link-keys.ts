/**
 * npm run link-keys -- base | solana   [--schemas]
 *
 * Links one of TenderScout's receiving keys (Base Sepolia or Solana devnet) to its Concordium owner in the
 * CIS-8 external key registry, so ProcureBot can verify the payee before paying it in EURC.
 *
 *   1. asks the registry for the canonical bytes the external key must sign (build_cis8_canonical_bytes)
 *   2. signs them with TenderScout's key from .env (EVM personal_sign, or Solana ed25519)
 *   3. builds the CIS-8 `register` call (build_cis8_register) and dry-runs it on Concordium testnet
 *   4. saves it to data/cis8-link-<chain>.json. The owner then signs and sends it from the dashboard:
 *      Policy → "Link TenderScout's keys" → Send with wallet (the owner account must be in the browser wallet).
 *
 * The registry's tool inputs are read from the MCP server itself (tools/list), so the script adapts to them.
 * --schemas prints those inputs and stops.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { credentials } from "@grpc/grpc-js";
import { ConcordiumGRPCNodeClient } from "@concordium/web-sdk/nodejs";
import { AccountAddress, ContractAddress, ContractName, EntrypointName, Parameter, ReceiveName, getEmbeddedModuleSchema, serializeUpdateContractParameters } from "@concordium/web-sdk";
import { secp256k1 } from "@noble/curves/secp256k1";
import { ed25519 } from "@noble/curves/ed25519";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { base58 } from "@scure/base";
import { config } from "../lib/config.js";
import { XCHAINS, sellerXAddress } from "../lib/chains.js";
import { registryListTools, registryTool } from "../lib/registry-mcp.js";

const chain = process.argv.slice(2).find((a) => !a.startsWith("--")) as "base" | "solana" | undefined;
const schemasOnly = process.argv.includes("--schemas");
const die = (msg: string): never => { console.error(`\n✗ ${msg}`); process.exit(1); };

const tools = await registryListTools();
const cis8 = tools.filter((t) => /cis8/i.test(t.name));
const tool = (name: string) => cis8.find((t) => t.name === name) ?? die(`the registry has no ${name} tool (it has: ${cis8.map((t) => t.name).join(", ")})`);
if (schemasOnly || !chain) {
  for (const t of cis8) console.log(`\n## ${t.name}\n${t.description ?? ""}\n${JSON.stringify(t.inputSchema, null, 2)}`);
  if (!chain) console.log("\nUsage: npm run link-keys -- base   (or solana)");
  process.exit(0);
}
if (chain !== "base" && chain !== "solana") die("say which key to link: npm run link-keys -- base   or   npm run link-keys -- solana");

const x = XCHAINS[chain];
const owner = process.env.SELLER_OWNER?.trim() || die("SELLER_OWNER (TenderScout's Concordium owner account) is empty in .env");
const address = sellerXAddress[chain]() || die(`no TenderScout ${x.name} address in .env; run npm run wallets first`);

// ---- the external key and how it proves itself ----
let publicKeyHex: string, keyType: string, proofScheme: string, sign: (msg: Uint8Array) => string;
if (chain === "base") {
  const priv = (process.env.SELLER_EVM_PRIVATE_KEY || die("SELLER_EVM_PRIVATE_KEY is empty; run npm run wallets")).replace(/^0x/, "");
  publicKeyHex = bytesToHex(secp256k1.getPublicKey(priv, false));
  keyType = "secp256k1-uncompressed";
  proofScheme = "ethereum-personal-sign";
  sign = (msg) => {
    // EIP-191 personal_sign over the raw canonical bytes → r || s || v (v = 27/28)
    const hash = keccak_256(new Uint8Array([...utf8ToBytes(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]));
    const sig = secp256k1.sign(hash, priv);
    return bytesToHex(new Uint8Array([...sig.toCompactRawBytes(), 27 + sig.recovery]));
  };
} else {
  const secret = (process.env.SELLER_SOLANA_SECRET_KEY || die("SELLER_SOLANA_SECRET_KEY is empty; run npm run wallets")).trim();
  const bytes = secret.startsWith("[") ? Uint8Array.from(JSON.parse(secret)) : base58.decode(secret);
  publicKeyHex = bytesToHex(bytes.slice(32, 64));
  if (base58.encode(bytes.slice(32, 64)) !== address) die("SELLER_SOLANA_SECRET_KEY does not belong to SELLER_SOLANA_ADDRESS");
  keyType = "ed25519";
  proofScheme = "solana-ed25519";
  sign = (msg) => bytesToHex(ed25519.sign(msg, bytes.slice(0, 32)));
}
const externalKey = { namespace: x.network, key_type: keyType, public_key_hex: publicKeyHex };

// Already linked?
const existing = await registryTool("owner_of_key", { external_key: externalKey }).catch(() => null);
if (existing?.status === "Active") {
  console.log(`✓ Already linked: ${x.name} ${address} → Concordium ${existing.owner} (${existing.proof_scheme}). Nothing to do.`);
  process.exit(0);
}

// ---- fill a tool's inputs from what we know, by property name ----
const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
const known: Record<string, unknown> = {
  externalkey: externalKey, key: externalKey,
  namespace: x.network, keytype: keyType, publickeyhex: publicKeyHex, publickey: publicKeyHex,
  // the registry's flat names (build_cis8_canonical_bytes / build_cis8_register)
  externalnamespace: x.network, externalkeynamespace: x.network, externalkeytype: keyType,
  externalpublickeyhex: publicKeyHex, externalpublickey: publicKeyHex, externaladdress: address,
  owner: owner, concordiumaccount: owner, account: owner, owneraccount: owner, sender: owner, accountaddress: owner,
  proofscheme: proofScheme, scheme: proofScheme,
  contract: { index: 12801, subindex: 0 }, contractaddress: { index: 12801, subindex: 0 },
  metadata: [],
};
function fill(schema: any, extra: Record<string, unknown> = {}) {
  const props = schema?.properties ?? {};
  const out: Record<string, unknown> = {};
  const missing: string[] = [];
  const pool = { ...known, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [norm(k), v])) };
  for (const [k, p] of Object.entries<any>(props)) {
    if (k === "network") continue; // added by registryTool
    const v = pool[norm(k)];
    const isObj = p?.type === "object" && p?.properties;
    if (isObj && !(v && typeof v === "object")) {
      // nested input (e.g. proof: { scheme, signature_hex }): fill it from the same pool
      const inner = fill(p, extra);
      if (Object.keys(inner.args).length) out[k] = inner.args;
      missing.push(...inner.missing.map((m) => `${k}.${m}`));
      if (!Object.keys(inner.args).length && (schema.required ?? []).includes(k)) missing.push(`${k} (${p?.description ?? "object"})`);
    } else if (v !== undefined) out[k] = v;
    else if ((schema.required ?? []).includes(k)) missing.push(`${k} (${p?.description ?? p?.type ?? "?"})`);
  }
  return { args: out, missing };
}
const firstHex = (r: any): string | undefined => {
  if (typeof r === "string") return /^(0x)?[0-9a-f]+$/i.test(r) ? r.replace(/^0x/, "") : undefined;
  for (const k of ["hex", "bytes_hex", "canonical_bytes_hex", "canonical_hex", "message_hex", "bytes", "message"]) {
    if (typeof r?.[k] === "string" && /^(0x)?[0-9a-f]+$/i.test(r[k])) return r[k].replace(/^0x/, "");
  }
  return undefined;
};

// 1. canonical bytes
const canonTool = tool("build_cis8_canonical_bytes");
const c1 = fill(canonTool.inputSchema);
if (c1.missing.length) die(`build_cis8_canonical_bytes needs inputs this script doesn't know: ${c1.missing.join(", ")}.\nRun npm run link-keys -- --schemas and send the output to your developer.`);
console.log(`Linking TenderScout's ${x.name} key ${address} to Concordium owner ${owner} (${proofScheme})…`);
const canon: any = await registryTool("build_cis8_canonical_bytes", c1.args);
const msgHex = firstHex(canon) ?? die(`couldn't find the bytes to sign in the registry's answer: ${JSON.stringify(canon).slice(0, 400)}`);
const signature = sign(hexToBytes(msgHex));
console.log(`  ✓ signed ${msgHex.length / 2} canonical bytes with the ${x.name} key`);

// 2. register payload
const regTool = tool("build_cis8_register");
const fromCanon = canon && typeof canon === "object" ? Object.fromEntries(Object.entries(canon).filter(([k]) => !/hex|bytes|message|schema/i.test(k))) : {};
const sigFields = { signature, signature_hex: signature, proof: signature, proof_hex: signature, proof_signature: signature, sig: signature, external_signature_hex: signature, external_signature: signature, proof_bytes_hex: signature, signed_message_hex: signature };
const r1 = fill(regTool.inputSchema, { ...fromCanon, ...sigFields, message_hex: msgHex, canonical_bytes_hex: msgHex, bytes_hex: msgHex });
if (process.argv.includes("--debug")) console.log("build_cis8_register inputs:", JSON.stringify(r1.args, null, 2));
if (r1.missing.length) die(`build_cis8_register needs inputs this script doesn't know: ${r1.missing.join(", ")}.\nRun npm run link-keys -- --schemas and send the output to your developer.`);
const reg: any = await registryTool("build_cis8_register", r1.args);
if (process.argv.includes("--debug")) console.log("build_cis8_register answer keys:", Object.keys(reg ?? {}).join(", "));

// 3. what to call: the registry names the contract and entrypoint (e.g. "CIS-8.registerExternalKey")
const grpc = new ConcordiumGRPCNodeClient(config.grpc.host, config.grpc.port, credentials.createSsl(), { timeout: 20_000 });
const ca = reg?.contract_address ?? { index: 12801, subindex: 0 };
const contract = ContractAddress.create(Number(ca.index), Number(ca.subindex ?? 0));
const info: any = await grpc.getInstanceInfo(contract);
const instanceName = String(info.name.value ?? info.name).replace(/^init_/, "");
const receiveName: string = reg?.receive_name ?? `${instanceName}.register`;
const [contractName, entrypoint] = receiveName.split(".");

// The browser wallet serializes JSON parameters with the contract's schema, so encode the registry's
// parameter_json the same way here and dry-run exactly those bytes.
let parameters: unknown = reg?.parameter_json ?? reg?.schema_json ?? reg?.parameters ?? null;
if (typeof parameters === "string") { try { parameters = JSON.parse(parameters); } catch { /* leave as is */ } }
const source = await grpc.getModuleSource(info.sourceModule);
const schema = (await getEmbeddedModuleSchema(source))!;
if (!schema?.buffer) die("the CIS-8 contract has no embedded schema, so the browser wallet can't build the call");
const schemaBase64 = Buffer.from(schema.buffer).toString("base64");
// versioned schemas carry their version; older unversioned ones need it passed along
const schemaVersion = schema.type === "versioned" ? undefined : (schema as any).version;
let paramHex: string;
try {
  paramHex = Parameter.toHexString(serializeUpdateContractParameters(ContractName.fromString(contractName), EntrypointName.fromString(entrypoint), parameters, schema.buffer, schemaVersion));
} catch (e) {
  die(`couldn't encode the registry's parameters with the contract schema: ${(e as Error).message}`);
}
const givenHex = (reg?.parameter_hex ?? reg?.hex ?? "").replace(/^0x/, "");
if (givenHex && givenHex !== paramHex!) die("the registry's parameter bytes differ from the schema encoding; send this output to your developer");
console.log(`  ✓ built ${receiveName} (${paramHex!.length / 2} parameter bytes)`);

const dry: any = await grpc.invokeContract({
  contract,
  method: ReceiveName.fromString(receiveName),
  parameter: Parameter.fromHexString(paramHex!),
  invoker: AccountAddress.fromBase58(owner),
});
if (dry.tag !== "success") die(`the dry run of ${receiveName} failed: ${JSON.stringify(dry.reason ?? dry, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 400)}`);
const used = Number(dry.usedEnergy?.value ?? dry.usedEnergy ?? 3000);
const energy = Math.ceil(used * 1.2) + 500;
console.log(`  ✓ dry run of ${receiveName} succeeded (${used} energy)`);

mkdirSync("data", { recursive: true });
const file = `data/cis8-link-${chain}.json`;
writeFileSync(file, JSON.stringify({
  chain, chainName: x.name, address, externalKey, proofScheme, owner,
  contract: { index: Number(ca.index), subindex: Number(ca.subindex ?? 0) }, contractName, receiveName, entrypoint,
  parameterHex: paramHex!, parameters, schemaBase64, schemaVersion: schemaVersion ?? null, maxEnergy: energy,
  preparedAt: new Date().toISOString(),
}, null, 2) + "\n");
console.log(`\nSaved ${file}. Now send it from the owner's wallet:
  Dashboard → Policy → "Link TenderScout's keys (CIS-8)" → Send with wallet,
  with the browser wallet on account ${owner}.
Then npm run link-keys -- ${chain} again to confirm it shows as linked.`);
process.exit(0);
