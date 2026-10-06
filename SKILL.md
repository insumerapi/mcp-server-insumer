---
name: insumer-verify
description: Privacy-preserving on-chain verification across 37 blockchains (incl. Bitcoin, Tron, Stellar, Sui). Verify wallet holdings, NFT ownership, EAS attestations, and identity with ECDSA-signed proofs. No balances exposed.
homepage: https://insumermodel.com/developers/
metadata:
  clawdbot:
    requires:
      env: ["INSUMER_API_KEY"]
      bins: ["npx"]
    install: ["npx -y mcp-server-insumer"]
---

# InsumerAPI Verification Skill

Privacy-preserving on-chain token and NFT verification across 37 blockchains (31 EVM + Solana + XRPL + Bitcoin + Tron + Stellar + Sui). Returns ECDSA-signed boolean results. No raw balances exposed.

**Version**: 1.14.1

## Overview

InsumerAPI lets agents evaluate wallet state against conditions without handling private keys or raw balance data. Every response is ECDSA P-256 signed, carries an ML-DSA-65 post-quantum companion since September 2026, and is independently verifiable.

Agents can:
- Verify token balances, NFT ownership, EAS attestations, and Farcaster identity
- Check multiple conditions in a single call (1-10)
- Get optional Merkle storage proofs for trustless verification
- Generate wallet trust fact profiles (single or batch)
- Discover merchants and generate signed discount codes
- Onboard and configure merchants end-to-end
- Buy API keys and credits with USDC, USDT, or BTC (no auth required)
- Integrate with ACP (OpenAI/Stripe) and UCP (Google) commerce protocols

## Setup

### 1. Get an API Key
Use the `insumer_setup` tool with your email — or sign up at [insumermodel.com/developers](https://insumermodel.com/developers/#pricing). Free tier available (instant, no credit card).

### 2. Environment Variables
```bash
export INSUMER_API_KEY="insr_live_..."
```

### 3. MCP Configuration
```json
{
  "mcpServers": {
    "insumer": {
      "command": "npx",
      "args": ["-y", "mcp-server-insumer"],
      "env": {
        "INSUMER_API_KEY": "insr_live_..."
      }
    }
  }
}
```

## Tools (27)

### Setup (free, no auth)

#### `insumer_setup(email, appName?)`
Generate a free InsumerAPI key instantly. Returns an `insr_live_...` key with 10 credits and 100 calls/day. No credit card required. One free key per email, with a per-IP daily limit.

### Key Discovery (free)

#### `insumer_jwks()`
Get the JWKS (RFC 7517): five entries over two keys. An ECDSA P-256 key under three kids (`insumer-attest-v1`, `insumer-attest-v2`, `insumer-trust-v2`) and an ML-DSA-65 post-quantum key under two (`insumer-attest-pq1`, `insumer-trust-pq1`). Match the entry by the `kid` (or `pqKid`) on the response, never by position. No authentication required.

### On-Chain Verification

#### `insumer_attest(wallet?, solanaWallet?, xrplWallet?, bitcoinWallet?, tronWallet?, stellarWallet?, suiWallet?, conditions, proof?, format?)`
Verify 1-10 on-chain conditions (token balances, NFT ownership, EAS attestations, Farcaster identity, boolean view calls, supply/amount ratios, ERC-8004 agent registration, ERC-7710 delegation validity) across 37 chains. Returns ECDSA-signed boolean results with `evaluatedCondition`, `conditionHash` (SHA-256), and `blockNumber`/`blockTimestamp`. Stellar results include `ledgerIndex`/`ledgerHash` and surface `assetCode` (which flows into conditionHash for non-native assets). Sui results include `checkpointSequence`/`checkpointDigest`. 1 credit (2 with `proof: "merkle"` for EIP-1186 Merkle storage proofs, available on 27 of the 31 EVM chains: not on ZKsync Era, Sei, Viction or XDC Network, and not on non-EVM chains). Optional `format: "jwt"` for ES256-signed JWT output.

#### `insumer_compliance_templates()`
List available EAS compliance templates (Coinbase Verified Account/Country/One on Base, Gitcoin Passport on Optimism). Pre-configured schema IDs, attester addresses, and decoder contracts. Free, no auth.

#### `insumer_wallet_trust(wallet, solanaWallet?, xrplWallet?, bitcoinWallet?, tronWallet?, stellarWallet?, suiWallet?, proof?)`
Generate an ECDSA-signed wallet trust fact profile. 145 base checks across 27 chains in 9 dimensions: stablecoins (USDC, USDT, OUSD, PYUSD, USDG, USD1, RLUSD, USDS, DAI, EURC across 23 EVM chains), governance, NFTs, staking, institutional stablecoins (EURCV, USDCV, USDC, BENJI across Ethereum, Solana, XRPL, Stellar, Sui), tokenized treasuries (BUIDL, USYC, OUSG, USTB, USDY), stablecoin deposits (Aave v3, sUSDS, sDAI, Morpho USDC vaults), wrapped bitcoin (cbBTC, WBTC, tBTC) and names (ENS, Basenames). Up to 166 checks across 29 chains in 13 dimensions with optional Solana, XRPL, Bitcoin, and Tron wallets; Stellar and Sui wallets switch on rows inside the base dimensions. Every check is a presence check. `conditionSetVersion` (currently `2026-10`) is signed and names the check list; log it, never reject on it. 3 credits (6 with merkle).

#### `insumer_batch_wallet_trust(wallets, proof?)`
Batch trust profiles for up to 10 wallets (each accepts `wallet`, `solanaWallet`, `xrplWallet`, `bitcoinWallet`, `tronWallet`, `stellarWallet`, `suiWallet`). Shared block fetches, 5-8x faster than sequential calls. Partial success supported. 3 credits/wallet (6 with merkle).

#### `insumer_verify(merchantId, wallet?, solanaWallet?, xrplWallet?)`
Create a signed discount code (INSR-XXXXX, 30-min expiry) for a wallet at a merchant. Returns tier and discount percentage. Takes an EVM, Solana or XRPL wallet. A code that carries a discount costs 1 credit from the API key that owns the store; a 0% result is free. A caller using another key is not charged.

### Discovery (free)

#### `insumer_list_merchants(token?, verified?, limit?, offset?)`
Browse the merchant directory. Filter by accepted token symbol, verification status. Returns company name, website, tokens accepted, and discount info.

#### `insumer_get_merchant(id)`
Get full public merchant profile including token tiers, NFT collections, discount mode, and verification status.

#### `insumer_list_tokens(chain?, symbol?, type?)`
List all registered tokens and NFT collections in the registry. Filter by chain ID, symbol, or asset type (token/nft).

#### `insumer_check_discount(merchant, wallet?, solanaWallet?, xrplWallet?)`
Calculate discount for a wallet at a merchant. Returns tier and discount percentage per token. Takes an EVM, Solana or XRPL wallet. Free, no credits consumed. An `rpc_failure` answer means a read did not complete; it is never "not eligible".

### Credits & Keys

#### `insumer_credits()`
Check verification credit balance, tier (free/pro/enterprise), and daily rate limit for the current API key.

#### `insumer_buy_key(txHash, chainId, amount, appName)`
Buy a new API key with USDC, USDT, BTC, or USDT-TRC20 (no auth required). Send the payment, then call with the transaction hash. Sender wallet becomes the key's identity. One key per wallet. Supported chains: Ethereum, Base, Polygon, Arbitrum, Optimism, BNB Chain, Avalanche, Solana, Bitcoin, Tron. USDC/USDT auto-detected on EVM and Solana; BTC converted to USD at market rate (1 confirmation); Tron accepts USDT-TRC20. Minimum $5. Non-refundable.

#### `insumer_buy_credits(txHash, chainId, amount, updateWallet?)`
Buy verification credits with USDC, USDT, BTC, or USDT-TRC20. Volume discounts: $5-$99 = $0.04/call, $100-$499 = $0.03, $500+ = $0.02. Minimum $5. Supported chains: Ethereum, Base, Polygon, Arbitrum, Optimism, BNB Chain, Avalanche, Solana, Bitcoin, Tron. Non-refundable.

#### `insumer_confirm_payment(code, txHash, chainId, amount)`
Confirm USDC or USDT payment for a discount code. After calling `insumer_verify`, confirm the on-chain payment. The server verifies the transaction receipt. Supported chains: Ethereum, Base, Polygon, Arbitrum, Optimism, BNB Chain, Avalanche, Solana.

### Merchant Onboarding (owner-only)

#### `insumer_create_merchant(companyName, companyId, location?)`
Create a new merchant, owned by the API key that creates it. The store has no balance of its own: that key pays for its codes, scans and taps, and `credits` in the response is that key's balance. A key can create a limited number of merchants (429 past it).

#### `insumer_merchant_status(id)`
Get full private merchant details: credits, token configs, NFT collections, directory status, verification status, USDC settings.

#### `insumer_configure_tokens(id, ownToken?, partnerTokens?)`
Configure merchant token discount tiers. Set own token and/or partner tokens. Max 8 tokens total. Each token can carry a display `name` and `logo`; the own token takes `enabled` (true or false). Tier discounts are whole numbers from 1 to 50.

#### `insumer_configure_nfts(id, nftCollections)`
Configure the NFT collections a merchant recognizes. Max 4 collections. Each grants a discount (a whole number from 1 to 50) or, with `benefitType: "recognition"`, recognition only. `enabled: false` keeps a collection switched off; carry it through when re-saving. An XRPL `taxon` is an integer from 0 to 4294967295.

#### `insumer_configure_settings(id, discountMode?, discountCap?, usdcPayment?)`
Update merchant settings: discount stacking mode (highest/stack/capped), cap (a whole number from 1 to 100), and USDC payment configuration.

#### `insumer_publish_directory(id)`
Publish (or refresh) the merchant's listing in the public directory.

#### `insumer_buy_merchant_credits(id, txHash, chainId, amount, updateWallet?)`
Kept for compatibility. A store has no balance of its own: a USDC, USDT, or BTC payment submitted here adds regular credits to the API key that owns the store, at a flat 25 credits per $1. Same chain support as `insumer_buy_credits`, which has the volume tiers.

### Domain Verification (owner-only)

#### `insumer_request_domain_verification(id, domain)`
Request a verification token for a merchant's domain. Returns the token and three methods: DNS TXT record, HTML meta tag, or file upload.

#### `insumer_verify_domain(id)`
Complete domain verification after placing the token. Verified merchants get a trust badge in the public directory. Rate limited per merchant (429 says when to retry).

### Commerce Protocol Integration

#### `insumer_acp_discount(merchantId, wallet?, solanaWallet?, xrplWallet?, items?)`
Check discount eligibility in OpenAI/Stripe Agentic Commerce Protocol (ACP) format. Returns coupon objects, applied/rejected arrays, and per-item allocations. A code that carries a discount costs the store's owner key 1 credit; a 0% result is free. A caller using another key is not charged.

#### `insumer_ucp_discount(merchantId, wallet?, solanaWallet?, xrplWallet?, items?)`
Check discount eligibility in Google Universal Commerce Protocol (UCP) format. Returns title, extension field, and applied array. A code that carries a discount costs the store's owner key 1 credit; a 0% result is free. A caller using another key is not charged.

#### `insumer_validate_code(code)`
Validate an INSR-XXXXX discount code. Returns validity, discount percent, and expiry. Free, no auth required.

## Handling `rpc_failure`

`insumer_attest`, `insumer_wallet_trust`, `insumer_verify`, `insumer_acp_discount`, `insumer_ucp_discount` and `insumer_check_discount` can answer `ok: false` with error code `rpc_failure` (HTTP 503). It means a read did not complete and nothing was signed. Retry after a short delay. It is never a "no": do not report it as a failed condition or as "not eligible". `insumer_batch_wallet_trust` answers normally and carries an `error` entry for any wallet whose reads did not complete.

## Supported Chains (37)

Ethereum, Base, Polygon, Arbitrum, Optimism, BNB Chain, Avalanche, XDC, Sonic, Gnosis, Mantle, Scroll, Linea, zkSync Era, Blast, Taiko, Ronin, Celo, Viction, opBNB, World Chain, Unichain, Ink, Sei, Berachain, ApeChain, Chiliz, Soneium, Plume, Robinhood Chain, Arc, Solana, XRPL, Bitcoin, Tron, Stellar, Sui.

## Security Model

- **No private keys required** — read-only verification, never handles signing keys
- **No balances exposed** — boolean results only (pass/fail), raw amounts never returned
- **ECDSA P-256 signatures** — every response cryptographically signed; since 2026-09-01 an ML-DSA-65 post-quantum companion (`pqSig`/`pqKid`, and `pqJwt` beside `jwt`) rides beside `sig`/`kid`
- **JWKS key discovery** — five entries over two keys at [/.well-known/jwks.json](https://insumermodel.com/.well-known/jwks.json) (RFC 7517; the post-quantum key as RFC 9964 `AKP` entries), matched by `kid` or `pqKid`, never by position
- **Optional Merkle proofs** — EIP-1186 storage proofs for trustless verification against block headers
- **Independent verification** — [`insumer-verify`](https://www.npmjs.com/package/insumer-verify) (npm, zero deps; also on [PyPI](https://pypi.org/project/insumer-verify/) for Python, same checks and test vectors) reports five verdicts: signature, condition hash, block freshness, expiry, and the post-quantum companion (1.8.1+)

## Links

- Homepage: https://insumermodel.com/developers/
- MCP Server: https://www.npmjs.com/package/mcp-server-insumer
- OpenAPI Spec: https://insumermodel.com/openapi.yaml
- GitHub: https://github.com/insumerapi/mcp-server-insumer
- Verifier: https://www.npmjs.com/package/insumer-verify
- Verifier (Python): https://pypi.org/project/insumer-verify/
- Verifier source: https://github.com/insumerapi/insumer-verify
