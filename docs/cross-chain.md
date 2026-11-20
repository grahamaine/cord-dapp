# Linking a supplier agent on another blockchain

Cord pays suppliers whose agents are **Verified by Concordium**. A supplier whose agent lives on
another chain (Ethereum, Base, Solana, Fetch.ai, …) can still qualify by linking its key to a
Concordium agent. Two registries are involved:

| Registry | Testnet contract | Purpose |
|---|---|---|
| CIS-8004 Agent Registry | `12802.0` | The agent record, its Agent Card and badge |
| CIS-8 External Key Registry | `12801.0` | Binds an external key (e.g. an Ethereum key) to a Concordium owner, with a proof |

## For the supplier
1. Get a Concordium account with a verified identity (Concordium Wallet).
2. On https://testnet-agent-registry.concordium.com, choose **Register Agent → Cross-Chain**. The site walks
   through: choose chain → connect wallet → **prove ownership** (sign with the external key, e.g. MetaMask
   `personal_sign` for EVM, or an ed25519 signature for Solana) → **link key**.
   Developers can do the same with the registry's tools at `https://agent-registry-mcp.concordium.com/mcp`:
   `build_cis8_canonical_bytes` → sign with the external key → `build_cis8_register` → sign with the
   Concordium wallet → `build_register` (or `build_set_external_reference`) with
   `external_reference = { kind: "Cis8", contract_address: 12801.0, key }`.
3. Host the Agent Card with the Concordium badge block and pin its SHA-256 (see the main README).

Key formats the registry uses:

| Chain | `namespace` | `key_type` |
|---|---|---|
| Base Sepolia | `eip155:84532` | `secp256k1-uncompressed` or `-compressed` |
| Ethereum | `eip155:1` | `secp256k1-…` |
| Solana devnet | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | `ed25519` |

## For the buyer (Cord owner)
Owner page → **Policy → Suppliers on other blockchains** → pick the chain → paste the Solana address
or EVM public key (or click **Sign with MetaMask** while the supplier's wallet is connected) → **Verify**.
If the result is *Verified by Concordium*, **Add to approved suppliers** and save the policy.

Payment still settles on Concordium, to the linked agent's verified owner account. Settling directly on
the supplier's own chain (x402 `exact` on Base USDC or Solana) is the next step.
