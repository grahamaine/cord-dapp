/**
 * Cross-chain supplier verification. Agents that live on other blockchains (Ethereum, Base,
 * Solana, Fetch.ai…) can link their key to a Concordium agent through the CIS-8 external key
 * registry. Cord looks the key up, finds the linked Concordium agent and its identity-verified
 * owner, and runs the normal Verified by Concordium badge check. A verified supplier can then be paid on
 * its own chain (EURC on Base Sepolia / Solana devnet, see src/lib/chains.ts) or on Concordium.
 *
 *   EVM (eip155:*)  secp256k1 public key. An address alone doesn't reveal the key, so callers
 *                   pass the public key, or an address + a personal_sign signature we recover from.
 *   Solana          the address IS the ed25519 public key (base58).
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { base58 } from "@scure/base";
import { registryTool } from "./registry-mcp.js";
import { checkBadge } from "./badge.js";

export const CHAINS = [
  { id: "eip155:84532", name: "Base Sepolia", family: "evm" },
  { id: "eip155:8453", name: "Base", family: "evm" },
  { id: "eip155:11155111", name: "Ethereum Sepolia", family: "evm" },
  { id: "eip155:1", name: "Ethereum", family: "evm" },
  { id: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", name: "Solana devnet", family: "solana" },
  { id: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", name: "Solana", family: "solana" },
] as const;

const CIS8 = { index: Number((process.env.CIS8_CONTRACT || "12801.0").split(".")[0]), subindex: 0 };
const strip0x = (h: string) => h.trim().replace(/^0x/i, "").toLowerCase();

/** EIP-191 personal_sign hash. */
function personalHash(message: string) {
  const m = utf8ToBytes(message);
  return keccak_256(new Uint8Array([...utf8ToBytes(`\x19Ethereum Signed Message:\n${m.length}`), ...m]));
}
export function evmAddressOf(publicKeyHex: string) {
  const pt = secp256k1.ProjectivePoint.fromHex(strip0x(publicKeyHex));
  return "0x" + bytesToHex(keccak_256(pt.toRawBytes(false).slice(1)).slice(-20));
}
/** Recover the signer's public key from an EVM personal_sign signature and check it matches the address. */
export function recoverEvmKey(address: string, message: string, signatureHex: string) {
  const sig = hexToBytes(strip0x(signatureHex));
  if (sig.length !== 65) throw new Error("signature must be 65 bytes");
  let v = sig[64];
  if (v >= 27) v -= 27;
  const pub = secp256k1.Signature.fromCompact(sig.slice(0, 64)).addRecoveryBit(v).recoverPublicKey(personalHash(message));
  const uncompressed = pub.toHex(false);
  if (evmAddressOf(uncompressed) !== address.toLowerCase()) throw new Error("signature was not made by that address");
  return uncompressed;
}

export interface XChainInput { namespace: string; publicKeyHex?: string; address?: string; signature?: string; message?: string }

export async function verifyCrossChain(input: XChainInput) {
  const chain = CHAINS.find((c) => c.id === input.namespace);
  if (!chain) throw new Error(`unsupported chain ${input.namespace}`);

  // 1. Work out the external public key(s) to look up.
  let keys: { key_type: string; public_key_hex: string }[] = [];
  let address = input.address?.trim();
  if (chain.family === "solana") {
    const pk = input.publicKeyHex ? strip0x(input.publicKeyHex) : bytesToHex(base58.decode(address ?? ""));
    if (pk.length !== 64) throw new Error("a Solana address is 32 bytes (base58)");
    address = address || base58.encode(hexToBytes(pk));
    keys = [{ key_type: "ed25519", public_key_hex: pk }];
  } else {
    let pub = input.publicKeyHex ? strip0x(input.publicKeyHex) : "";
    if (!pub) {
      if (!address || !input.signature || !input.message) throw new Error("for EVM, give the public key, or the address plus a personal_sign signature");
      pub = recoverEvmKey(address, input.message, input.signature);
    }
    const pt = secp256k1.ProjectivePoint.fromHex(pub);
    address = address || evmAddressOf(pub);
    // The registry may store either form; try both.
    keys = [
      { key_type: "secp256k1-uncompressed", public_key_hex: pt.toHex(false) },
      { key_type: "secp256k1-compressed", public_key_hex: pt.toHex(true) },
    ];
  }

  // 2. CIS-8: who owns this key on Concordium?  3. Which agent references it?
  let binding: any = null, agent: any = null, usedKey = keys[0];
  for (const k of keys) {
    const external_key = { namespace: chain.id, ...k };
    binding ??= await registryTool("owner_of_key", { external_key });
    agent ??= await registryTool("agent_by_external_reference", { external_reference: { kind: "Cis8", contract_address: CIS8, key: external_key } });
    if (binding || agent) { usedKey = k; if (binding && agent) break; }
  }

  // 4. Normal Verified by Concordium badge check on the linked agent.
  const badge = agent?.token_address ? await checkBadge(agent.token_address) : null;
  const agentVerified = Boolean(badge?.verified && binding?.status === "Active");
  // Or: the key is bound (Active) to a Concordium owner that already runs a Verified by Concordium agent.
  const ownerBadge = !agentVerified && binding?.status === "Active" && binding?.owner ? await checkBadge(binding.owner) : null;
  const verified = agentVerified || Boolean(ownerBadge?.verified);
  return {
    chain: chain.name,
    namespace: chain.id,
    address,
    keyType: usedKey.key_type,
    publicKeyHex: usedKey.public_key_hex,
    linked: Boolean(binding),
    keyStatus: binding?.status ?? null,
    proofScheme: binding?.proof_scheme ?? null,
    concordiumOwner: binding?.owner ?? agent?.owner_account ?? null,
    agent: agent ? { tokenId: agent.token_id_u64 ?? agent.token_id, tokenAddress: agent.token_address, agentUri: agent.agent_uri, status: agent.status } : null,
    badgeValid: Boolean(badge?.verified),
    badgeIssues: badge?.issues ?? [],
    verified,
    summary: agentVerified
      ? `Verified: ${chain.name} key linked to Concordium agent #${agent.token_id_u64 ?? agent.token_id}, owned by an identity-verified account.`
      : verified
      ? `Verified: ${chain.name} key linked through CIS-8 to Concordium account ${binding.owner}, which owns ${ownerBadge!.agents} Verified by Concordium agent${ownerBadge!.agents === 1 ? "" : "s"}.`
      : !binding && !agent
        ? `No Concordium agent is linked to this ${chain.name} key.`
        : `Linked, but the badge check failed: ${(badge?.issues ?? ["key binding not active"]).join("; ")}`,
  };
}
