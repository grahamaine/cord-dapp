/**
 * npm run solana:token — set up a demo euro token on Solana devnet when Circle's EURC faucet won't deliver.
 *
 * In one go, from ProcureBot's Solana wallet (BUYER_SOLANA_SECRET_KEY):
 *   1. gets a little devnet SOL for fees if needed (free devnet airdrop)
 *   2. creates a token mint with 6 decimals, like EURC (ProcureBot is the mint authority)
 *   3. creates the token accounts for ProcureBot and TenderScout (SELLER_SOLANA_ADDRESS)
 *   4. mints 10,000 demo euro tokens to ProcureBot
 *   5. writes EURC_SOLANA=<mint> into .env, so Kakasa's Solana invoices settle in it
 *
 * Run it again any time: it reuses the mint in .env (if ProcureBot controls it) and tops ProcureBot up.
 * This is a testnet stand-in for Circle EURC; on mainnet Kakasa uses Circle's EURC mint.
 * Restart Kakasa afterwards (Ctrl+C, then npm run all).
 */
import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { base58 } from "@scure/base";
import {
  address, appendTransactionMessageInstructions, createKeyPairSignerFromBytes, createSolanaRpc, createTransactionMessage,
  generateKeyPairSigner, getBase64EncodedWireTransaction, getSignatureFromTransaction, lamports, pipe,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
  type Address, type Instruction, type KeyPairSigner,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_PROGRAM_ADDRESS, fetchMaybeMint, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction, getMintSize, getMintToInstruction,
} from "@solana-program/token";
import { XCHAINS, buyerXKey, sellerXAddress, rpcProblems } from "../lib/chains.js";

const DECIMALS = 6;
const TOP_UP = 10_000n * 10n ** BigInt(DECIMALS); // 10,000 demo euro
const RPC_URL = XCHAINS.solana.rpcUrl;
const rpc = createSolanaRpc(RPC_URL);
const explorer = (kind: "address" | "tx", id: string) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (msg: string): never => { console.error(`\n✗ ${msg}`); process.exit(1); };

async function confirm(sig: string, what: string) {
  for (let i = 0; i < 60; i++) {
    const { value } = await rpc.getSignatureStatuses([sig as any]).send();
    const s = value[0];
    if (s?.err) fail(`${what} failed on-chain: ${JSON.stringify(s.err)} (${explorer("tx", sig)})`);
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return;
    await sleep(1000);
  }
  fail(`${what} wasn't confirmed within a minute. Check ${explorer("tx", sig)} and run this again.`);
}

async function send(payer: KeyPairSigner, ixs: Instruction[], what: string) {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  const sig = getSignatureFromTransaction(tx);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64", preflightCommitment: "confirmed" }).send();
  await confirm(sig, what);
  console.log(`  ✓ ${what}  ${explorer("tx", sig)}`);
}

function setEnv(key: string, value: string) {
  const path = ".env";
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^#?\\s*${key}=.*$`, "m");
  writeFileSync(path, re.test(text) ? text.replace(re, line) : `${text.replace(/\n*$/, "\n")}${line}\n`);
}

const wrong = rpcProblems().filter((p) => p.startsWith("SOLANA"));
if (wrong.length) fail(wrong[0]);
// ---- who ----
const secret = buyerXKey.solana() || fail("BUYER_SOLANA_SECRET_KEY is empty in .env: run npm run wallets first.");
const bytes = secret.startsWith("[") ? Uint8Array.from(JSON.parse(secret)) : base58.decode(secret);
const buyer = await createKeyPairSignerFromBytes(bytes);
const sellerStr = sellerXAddress.solana() || fail("SELLER_SOLANA_ADDRESS is empty in .env: run npm run wallets first.");
const seller = address(sellerStr);
console.log(`Solana devnet (${RPC_URL.replace(/\/v2\/.*/, "/v2/…")})\n  ProcureBot  ${buyer.address}\n  TenderScout ${seller}\n`);

// ---- 1. SOL for fees ----
const NEED = 50_000_000n; // 0.05 SOL covers the mint and two token accounts
let sol = (await rpc.getBalance(buyer.address).send()).value;
if (sol < NEED) {
  console.log("Getting free devnet SOL for fees…");
  try {
    const sig = await rpc.requestAirdrop(buyer.address, lamports(1_000_000_000n)).send();
    await confirm(sig, "devnet SOL airdrop (1 SOL)");
    sol = (await rpc.getBalance(buyer.address).send()).value;
  } catch (e) {
    fail(`The devnet airdrop was refused (${(e as Error).message.slice(0, 120)}).
  Get free devnet SOL for ProcureBot another way, then run this again:
    • https://faucet.solana.com  (paste ${buyer.address}, choose Devnet)
    • or https://www.alchemy.com/faucets/solana-devnet`);
  }
}
console.log(`  ✓ ProcureBot has ${(Number(sol) / 1e9).toFixed(3)} SOL for fees`);

// ---- 2. the mint (reuse the one in .env if ProcureBot controls it) ----
let mint: Address | null = null;
const current = process.env.EURC_SOLANA?.trim();
if (current) {
  const m = await fetchMaybeMint(rpc, address(current)).catch(() => null);
  if (m?.exists && m.data.mintAuthority.__option === "Some" && m.data.mintAuthority.value === buyer.address) {
    mint = m.address;
    console.log(`  ✓ reusing demo euro mint ${mint}`);
  }
}
const ixs: Instruction[] = [];
if (!mint) {
  const mintSigner = await generateKeyPairSigner();
  mint = mintSigner.address;
  const space = BigInt(getMintSize());
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
  ixs.push(
    getCreateAccountInstruction({ payer: buyer, newAccount: mintSigner, lamports: rent, space, programAddress: TOKEN_PROGRAM_ADDRESS }),
    getInitializeMint2Instruction({ mint, decimals: DECIMALS, mintAuthority: buyer.address, freezeAuthority: null }),
  );
}

// ---- 3 + 4. token accounts and 10,000 demo euro for ProcureBot ----
const [buyerAta] = await findAssociatedTokenPda({ owner: buyer.address, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
const [sellerAta] = await findAssociatedTokenPda({ owner: seller, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
ixs.push(
  getCreateAssociatedTokenIdempotentInstruction({ payer: buyer, owner: buyer.address, mint, ata: buyerAta }),
  getCreateAssociatedTokenIdempotentInstruction({ payer: buyer, owner: seller, mint, ata: sellerAta }),
  getMintToInstruction({ mint, token: buyerAta, mintAuthority: buyer, amount: TOP_UP }),
);
await send(buyer, ixs, ixs.length > 3 ? "created the demo euro mint, both token accounts, and minted 10,000 to ProcureBot" : "token accounts ready, minted 10,000 more to ProcureBot");

// ---- 5. .env ----
setEnv("EURC_SOLANA", mint);
const bal = await rpc.getTokenAccountBalance(buyerAta).send();
console.log(`
✓ Solana is ready
   Demo euro mint:  ${mint}   ${explorer("address", mint)}
   ProcureBot holds ${bal.value.uiAmountString} (6 decimals, like EURC)
   TenderScout can receive at ${sellerAta}
   .env updated:    EURC_SOLANA=${mint}

Restart Kakasa (Ctrl+C, then npm run all), then press Release on the Solana invoice.`);
