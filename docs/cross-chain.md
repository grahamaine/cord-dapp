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

Kakasa can then pay the supplier on its own chain, in EURC through x402 `exact` (Base Sepolia, Solana devnet),
or its verified owner on Concordium. See "Settlement on Base and Solana" in the README.

## Linking TenderScout's own keys (demo)
`npm run wallets` creates TenderScout's Base and Solana keys; `npm run link-keys -- base` / `-- solana` signs the
registry's canonical bytes with them, builds the CIS-8 `register` call and dry-runs it; the owner then sends it from
the dashboard (Policy → *Link TenderScout's keys*). A key bound to an owner account that already runs a
Verified by Concordium agent counts as verified, without registering a new agent.

Both links are live on testnet (23 Nov 2026), owned by `3wT8KD…Ph6h8`:

| Chain | TenderScout key | CIS-8 link transaction |
|---|---|---|
| Base Sepolia | `0x0288658cE06d2eF1F63b4C7e1e9072aE8cFde4BC` | [f8d6c932…](https://ccdexplorer.io/testnet/transaction/f8d6c93210790ba53a71b65bb93e0a3932b44ee295c692ac518292d38f352aff) |
| Solana devnet | `GDmQ2WahUCmVJ529aDUoRTtBehXnj3Q8Sv1RYGRU737R` | [978a836f…](https://ccdexplorer.io/testnet/transaction/978a836f7057424ff98aa2644e3b2b3ecdbf07455f29e67355c8694398f79525) |

The first payment through a link settled on Base Sepolia:
[0xce929862…](https://sepolia.basescan.org/tx/0xce9298625089a76251949cefc91a914886ecc4bcd8497a5db3770ca5bf9bba7e)
(MTN Uganda invoice, 1.15 EURC).
