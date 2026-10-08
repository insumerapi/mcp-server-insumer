# mcp-server-insumer

[![npm](https://img.shields.io/npm/v/mcp-server-insumer)](https://www.npmjs.com/package/mcp-server-insumer) [![Glama](https://glama.ai/mcp/servers/insumerapi/mcp-server-insumer/badge)](https://glama.ai/mcp/servers/insumerapi/mcp-server-insumer) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

MCP server for [InsumerAPI](https://insumermodel.com/developers/): condition-based access infrastructure. Send a wallet and conditions, get a signed boolean across 37 chains. No balances exposed, no identity required. Every result is signed and checkable offline against the published keys, and on EVM chains an optional Merkle proof lets the verifier check the balance against the block header without trusting the API.

Enables AI agents (Claude Desktop, Cursor, Windsurf, and any MCP-compatible client) to add condition-based access to any workflow: verify on-chain conditions, discover merchants, generate signed discount codes, and onboard new merchants.

**In production:** [AsterPay](https://github.com/AsterPay/erc8183-kya-hook), a regulated payments stack, uses InsumerAPI attestations in its live ERC-8183 agentic-commerce trust checks. [Case study](https://insumermodel.com/blog/asterpay-kya-erc8183-attestation-integration.html).

Also available as: [LangChain](https://pypi.org/project/langchain-insumer/) (26 tools, PyPI) | [ElizaOS](https://www.npmjs.com/package/@insumermodel/plugin-eliza) (10 actions, npm) | [OpenAI GPT](https://chatgpt.com/g/g-699c5e43ce2481918b3f1e7f144c8a49-insumerapi-wallet-auth) (GPT Store) | [insumer-verify](https://www.npmjs.com/package/insumer-verify) (client-side verification, npm)

**[Full AI Agent Verification API guide](https://insumermodel.com/ai-agent-verification-api/)**: covers all 37 chains, trust profiles, commerce protocols, and signature verification.

## Quick Start

### Claude Desktop

Add to your `claude_desktop_config.json`:

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

### Cursor / Windsurf

Add to your MCP settings:

```json
{
  "insumer": {
    "command": "npx",
    "args": ["-y", "mcp-server-insumer"],
    "env": {
      "INSUMER_API_KEY": "insr_live_..."
    }
  }
}
```

### Get a key: no signup, no dashboard, no password

Three paths, all give you a working `insr_live_...` key in seconds with 10 free verifications plus 100 requests a day. One free key per email.

**Option A: let your agent do it.** Start the server without a key. Your AI agent can call the `insumer_setup` tool with your email to generate a free key instantly. Add it to your config and restart.

**Option B: terminal.**

```bash
curl -s -X POST https://api.insumermodel.com/v1/keys/create \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "appName": "MCP Server", "tier": "free"}'
```

**Option C: browser.** Enter your email on [insumermodel.com](https://insumermodel.com/?utm_source=npm-mcp-server-insumer) and the key appears inline.

Set it as `INSUMER_API_KEY` in your config.

**Already have a key?** Manage usage, top up, or upgrade at [insumermodel.com/developers/account/](https://insumermodel.com/developers/account/?utm_source=npm-mcp-server-insumer).

### Option D: pay per call with x402 (no key at all)

Instead of a key, set `INSUMER_PAYMENT_KEY` to a **throwaway Base wallet** funded with a few dollars of USDC. Metered calls (`insumer_attest`, `insumer_wallet_trust`, `insumer_batch_wallet_trust`) are then paid inline via [x402](https://www.x402.org): the server requests a price, signs an EIP-3009 USDC authorization on Base, and retries. No signup, no credits, no dashboard.

```json
{
  "mcpServers": {
    "insumer": {
      "command": "npx",
      "args": ["-y", "mcp-server-insumer"],
      "env": { "INSUMER_PAYMENT_KEY": "0x<throwaway-wallet-private-key>" }
    }
  }
}
```

- Base USDC only; the wallet needs USDC but **no ETH** (settlement is gasless).
- Each call spends a few cents (attest $0.05, trust $0.15). Use a **dedicated throwaway wallet** funded with a small amount, never a wallet holding meaningful funds.
- **Every quote is checked before the wallet signs.** The server pays only InsumerAPI's own receiving address (`0xAd982CB19aCCa2923Df8F687C0614a7700255a23`), only in USDC on Base, and never more than the cap: **$3.00 per call by default**, the price of the largest call today (a 10-wallet trust batch with Merkle proofs). Anything else is refused and nothing is signed. Set `INSUMER_MAX_PAYMENT_USDC` to change the cap, e.g. `"0.25"` if you only attest. The cheapest call is $0.05, so a cap below that refuses every paid call (the server warns at startup). A malformed value turns pay-per-call off rather than falling back to the default.
- If both `INSUMER_API_KEY` and `INSUMER_PAYMENT_KEY` are set, the key (credits) is used.

## Hosted endpoint (no install)

The same server runs at **`https://api.insumermodel.com/mcp`** over MCP streamable HTTP, for clients that connect by URL: ChatGPT plugins and developer-mode connectors, claude.ai custom connectors, and hosted agent platforms that cannot run an npm package. Paste the URL; there is nothing to configure.

It is shared and anonymous, so it serves the ten tools that make sense without a caller identity (`HOSTED_TOOLS`: signing keys, attest, compliance templates, wallet trust and batch trust, the merchant and token directories, the free discount check, code validation), and the metered tools share one free daily allowance. Past it, a call is refused with a pointer here. For your own allowance, key and credit management, or the merchant tools, run the package locally with your key as above.

To host the server yourself, build it and run `node build/http.js` with `INSUMER_API_KEY` set (`PORT`, `INSUMER_HOSTED_TOOLS` and `INSUMER_DAILY_CAP` are optional), or embed it: `createInsumerServer(options)` from the package root returns a configured server for any transport.

## What You Get Back

When your agent calls `insumer_attest`, you get an ECDSA-signed attestation:

```json
{
  "ok": true,
  "data": {
    "attestation": {
      "id": "ATST-A7C3E1B2D4F56789",
      "pass": true,
      "results": [
        {
          "condition": 0,
          "met": true,
          "label": "USDC >= 1000 on Ethereum",
          "type": "token_balance",
          "chainId": 1,
          "evaluatedCondition": {
            "chainId": 1,
            "contractAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            "operator": "gte",
            "threshold": "1000",
            "type": "token_balance"
          },
          "conditionHash": "0x8a3b...",
          "blockNumber": "0x1799043",
          "blockTimestamp": "2026-03-26T20:04:23.000Z"
        }
      ],
      "passCount": 1,
      "failCount": 0,
      "attestedAt": "2026-02-28T12:34:57.000Z",
      "expiresAt": "2026-02-28T13:04:57.000Z"
    },
    "sig": "NgA7BO8SAildiTrgIQY2UyXsBrySZknkP85pT2Zqv8Hq0KsCsB8DRFVMkXgnXtCXrbb726Is6k4LyyBYU+f/Pw==",
    "kid": "insumer-attest-v2",
    "pqSig": "<base64 ML-DSA-65 signature>",
    "pqKid": "insumer-attest-pq1"
  },
  "meta": {
    "version": "1.0",
    "timestamp": "2026-02-28T12:34:57.000Z",
    "creditsRemaining": 99,
    "creditsCharged": 1
  }
}
```

The `sig` is an ECDSA P-256 signature (base64, P1363 r||s, 88 characters). The `kid` identifies the key and selects the signed bytes: `insumer-attest-v2` signs `"insumer.attestation.v2\n" + canonical_json({v: 2, id, pass, results, attestedAt})` (keys sorted at every level); `insumer-attest-v1` signs the bare `JSON.stringify` of `{id, pass, results, attestedAt}` in insertion order. Every attest and trust response is signed twice: ES256 and a post-quantum ML-DSA-65 signature, `pqSig` and `pqKid` (over the post-quantum domain tag plus the same classical preimage the `kid` selects; `pqJwt` beside `jwt`), added beside `sig` and `kid` without changing them. The `conditionHash` is a SHA-256 of the exact condition logic that was evaluated.

No balances. No amounts. Just a cryptographically signed true/false.

For XRPL conditions, results include `ledgerIndex`, `ledgerHash` (validated ledger hash), and `trustLineState: { frozen: boolean }` instead of `blockNumber`/`blockTimestamp`. Native XRP conditions include `ledgerIndex` and `ledgerHash` but not `trustLineState`. Frozen trust lines cause `met: false`.

### Wallet Auth (JWT)

Add `format: "jwt"` to the `insumer_attest` tool parameters to receive the attestation as a standard JWT bearer token:

```json
{
  "wallet": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  "conditions": [ ... ],
  "format": "jwt"
}
```

The response includes an additional `jwt` field containing an ES256-signed JWT, and beside it a `pqJwt` sibling (a compact JWS with `alg` ML-DSA-65 carrying the same claims, signed under `insumer-attest-pq1`). The `jwt` token is verifiable by any standard JWT library via the JWKS endpoint at `GET /v1/jwks`, which makes it compatible with Kong, Nginx, Cloudflare Access, AWS API Gateway, and other middleware that accepts JWT bearer tokens.

## Verify the Response

Your agent gets the attestation. Your application should verify it. Install [insumer-verify](https://www.npmjs.com/package/insumer-verify) (also on [PyPI](https://pypi.org/project/insumer-verify/) for Python: `pip install insumer-verify`, same checks, same 27 published test vectors):

```bash
npm install insumer-verify
```

```typescript
import { verifyAttestation } from "insumer-verify";

// attestationResponse = the full API envelope {ok, data: {attestation, sig, kid, pqSig, pqKid}, meta}
// Do NOT pass attestationResponse.data; the function expects the outer envelope
const result = await verifyAttestation(attestationResponse, {
  jwksUrl: "https://insumermodel.com/.well-known/jwks.json",
  maxAge: 120, // reject if block data is older than 2 minutes
});

if (result.valid) {
  // Signature verified, condition hashes match, not expired
  const pass = attestationResponse.data.attestation.pass;
  console.log(`Attestation ${pass ? "passed" : "failed"} all conditions`);
} else {
  console.log("Verification failed:", result.checks);
}
```

This reports five independent verdicts: ECDSA signature, condition hash integrity, block freshness, attestation expiry, and the post-quantum signature (`insumer-verify` 1.8.1+ reports it as verified, refuted, absent, or unverifiable). Zero runtime dependencies, uses Web Crypto API.

## Tools (27)

### Setup (free, no auth)

| Tool | Description |
|------|-------------|
| `insumer_setup` | Generate a free API key instantly. Takes an email, returns an `insr_live_...` key with 10 free verifications plus 100 requests a day. No credit card required. |

### Key Discovery (free)

| Tool | Description |
|------|-------------|
| `insumer_jwks` | Get the JWKS: five entries over two keys. The ECDSA P-256 key under `insumer-attest-v1`, `insumer-attest-v2`, and `insumer-trust-v2`, followed by the ML-DSA-65 post-quantum key under two RFC 9964 `AKP` entries, `insumer-attest-pq1` and `insumer-trust-pq1`. Match by the `kid` (or `pqKid`) on the response, never by position. |

### On-Chain Verification (cost credits)

> **`token_balance` thresholds are decimal strings.** Pass `threshold` as `"100"`, not `100`. Keys created from 2026-06-10 sign with `kid: insumer-attest-v2`, which preserves full precision and rejects a JSON number with a `400`. The `insumer_attest` tool accepts a number or string and coerces to the canonical string; older `insumer-attest-v1` keys accept either.

| Tool | Description |
|------|-------------|
| `insumer_attest` | Verify on-chain conditions (token balances, NFT ownership, EAS attestations, Farcaster identity, `evm_view_call` for arbitrary boolean view functions, `ratio_to_amount` for self-scaling agent-spend limits and `ratio_to_supply` for share-of-supply rules; all three EVM only, plus `erc8004_agent` for ERC-8004 agent registration and `erc7710_delegation` for MetaMask-framework delegation validity, both on Base, and `account_code` for the code state of the wallet address itself on an EVM chain: `expect` is `none` for a plain key account, `eip7702` for an EIP-7702 delegation designator, optionally to a given `delegate`, or `contract` for any other code; the answer is met or not met, and the code and the delegation target are never returned). Returns ECDSA-signed boolean with `kid`, `evaluatedCondition`, `conditionHash` (SHA-256), and `blockNumber`/`blockTimestamp`. 1 credit. Optional `proof: "merkle"` for EIP-1186 Merkle proofs (2 credits): a balance-slot storage proof for token balances, an account proof (subject `account_balance`) for the native coin, an account proof (subject `account_code`) for `account_code`, and a revocation-slot proof (subject `delegation_revocation`) for `erc7710_delegation`. |
| `insumer_compliance_templates` | List available EAS compliance templates (Coinbase Verifications on Base, Gitcoin Passport on Optimism). Free. |
| `insumer_wallet_trust` | Generate ECDSA-signed wallet trust fact profile. 155 base checks across 27 chains in 10 dimensions (stablecoins, governance, NFTs, staking, institutional stablecoins, tokenized treasuries, stablecoin deposits, wrapped bitcoin, names, account), up to 176 checks across 29 chains in 14 dimensions with optional Solana, XRPL, Bitcoin, and Tron wallets (Stellar and Sui wallets switch on rows inside the base dimensions). Every check is a presence check; the account dimension's two rows per chain (contract code, EIP-7702 delegation, on Ethereum, Base, Arbitrum, Optimism and Polygon) are present or not present. Dimensions arrive in a fixed order: the base dimensions as listed, then any of solana, xrpl, bitcoin and tron that were switched on. The signed `conditionSetVersion` (currently `2026-10-08`) names the check list; log it, never reject on it. 3 credits (6 with merkle; the premium is refunded whenever no proof is delivered). |
| `insumer_batch_wallet_trust` | Batch trust profiles for up to 10 wallets. Each wallet object supports optional `solanaWallet`, `xrplWallet`, `bitcoinWallet`, `tronWallet`, `stellarWallet`, and `suiWallet`. Faster than sequential calls. Partial success supported. 3 credits/wallet (6 with merkle). The text is a per-wallet summary by default (dimensions in their fixed order, identical for every wallet; the account dimension's checks are present rather than held) and the complete signed profiles are in `structuredContent`; `detail: "full"` puts them in the text too (set it on the call: profiles cannot be fetched again). |
| `insumer_verify` | Create signed discount code (INSR-XXXXX, 30-min expiry) for a wallet at a merchant. A code that carries a discount costs 1 credit from the API key that owns the store; a 0% result is free. A caller using another key is not charged. Optional `walletProof` proves you control the EVM wallet: full discount, no daily limit. |

### Discovery (free)

| Tool | Description |
|------|-------------|
| `insumer_list_merchants` | Browse the merchant directory. Filter by token, verification status. |
| `insumer_get_merchant` | Get full public merchant profile. |
| `insumer_list_tokens` | List the tokens and NFTs listed in the Insumer registry. Filter by chain, symbol, type. A directory, not the list of what can be checked: an attestation checks any token on a supported chain, and NFTs on EVM chains, Solana and XRPL. |
| `insumer_check_discount` | Calculate discount for a wallet at a merchant. |

### Credits & Keys

| Tool | Description |
|------|-------------|
| `insumer_buy_key` | Buy a new API key with USDC, USDT, BTC, or USDT-TRC20 (no auth required). Agent-friendly: no email needed, sender wallet becomes the key's identity. One key per wallet. Volume discounts: $0.04–$0.02/call. Supported chains: Ethereum, Base, Polygon, Arbitrum, Optimism, BNB Chain, Avalanche, Solana, Bitcoin, Tron. Non-refundable. |
| `insumer_credits` | Check credit balance and tier. |
| `insumer_buy_credits` | Buy verification credits with USDC, USDT, BTC, or USDT-TRC20. Volume discounts: $0.04–$0.02/call. Supported chains: Ethereum, Base, Polygon, Arbitrum, Optimism, BNB Chain, Avalanche, Solana, Bitcoin, Tron. Non-refundable. First purchase registers sender wallet; subsequent purchases must match or include `updateWallet: true`. |
| `insumer_confirm_payment` | Confirm USDC payment for a discount code. |

### Merchant Onboarding (owner-only)

| Tool | Description |
|------|-------------|
| `insumer_create_merchant` | Create new merchant, owned by the key that creates it. No balance of its own: that key pays for its codes, scans and taps. |
| `insumer_merchant_status` | Get full private merchant details. |
| `insumer_configure_tokens` | Set token discount tiers. Tier discounts are whole numbers from 1 to 50. Tokens can carry a display `name` and `logo`; the own token takes `enabled`. |
| `insumer_configure_nfts` | Set NFT collections: a whole-number discount from 1 to 50, or `benefitType: "recognition"` for recognition only. `enabled: false` keeps a collection switched off. |
| `insumer_configure_settings` | Set discount mode, cap, the terms for wallets without proof of control, USDC payments. |
| `insumer_publish_directory` | Publish merchant to public directory. |
| `insumer_buy_merchant_credits` | Kept for compatibility. A store has no balance of its own: a USDC, USDT, BTC, or USDT-TRC20 payment submitted here adds regular credits to the API key that owns the store, at a flat 25 credits per $1 (`insumer_buy_credits` has the volume tiers). Owner only. Non-refundable. First purchase registers sender wallet; subsequent purchases must match or include `updateWallet: true`. |

### Domain Verification (owner-only)

| Tool | Description |
|------|-------------|
| `insumer_request_domain_verification` | Request a verification token for a merchant's domain. Returns token and 3 methods (DNS TXT, meta tag, file upload). |
| `insumer_verify_domain` | Complete domain verification after placing the token. Verified merchants get a trust badge. |

### Commerce Protocol Integration

| Tool | Description |
|------|-------------|
| `insumer_acp_discount` | Check discount eligibility in OpenAI/Stripe ACP format. Returns coupon objects and per-item allocations. A code that carries a discount costs the store's owner key 1 credit; a 0% result is free. A caller using another key is not charged. |
| `insumer_ucp_discount` | Check discount eligibility in Google UCP format. Returns title, extension field, and applied array. A code that carries a discount costs the store's owner key 1 credit; a 0% result is free. A caller using another key is not charged. |
| `insumer_validate_code` | Validate an INSR-XXXXX discount code. Returns validity, discount percent, expiry. Free, no auth. |

## Pricing

**Tiers:** Free (10 free verifications plus 100 requests a day) | Pro $29/mo (1,000 credits/mo, 10,000/day) | Enterprise $99/mo (5,000 credits/mo, 100,000/day)

**Volume discounts:** $5–$99 = $0.04/call (25 credits/$1) · $100–$499 = $0.03 (33/$1, 25% off) · $500+ = $0.02 (50/$1, 50% off)

**Platform wallets:**
- **EVM (USDC/USDT):** `0xAd982CB19aCCa2923Df8F687C0614a7700255a23`
- **Solana (USDC/USDT):** `6a1mLjefhvSJX1sEX8PTnionbE9DqoYjU6F6bNkT4Ydr`
- **Bitcoin:** `bc1qg7qnerdhlmdn899zemtez5tcx2a2snc0dt9dt0`
- **Tron (USDT-TRC20):** `TC5yvwkAMakkXtUxYiu2Yn1xbBcwYuD6cn`

**Supported payment chains:** Ethereum, Base, Polygon, Arbitrum, Optimism, BNB Chain, Avalanche, Solana, Bitcoin, Tron. Tokens sent on unsupported chains cannot be recovered. All purchases are final and non-refundable. [Full pricing →](https://insumermodel.com/pricing/)

## Handling `rpc_failure` Errors

If the API cannot reach one or more blockchain data sources after retries, `insumer_attest`, `insumer_wallet_trust`, `insumer_verify`, `insumer_acp_discount`, `insumer_ucp_discount` and `insumer_check_discount` return `ok: false` with error code `rpc_failure`. No signature, no JWT, no credits charged. `insumer_batch_wallet_trust` answers normally and carries an `error` entry for any wallet whose reads did not complete, beside the wallets that were signed. This is a retryable error: the MCP client should retry after a short delay (2-5 seconds).

**Important:** `rpc_failure` is NOT a verification failure. Do not treat it as `pass: false`. It means the data source was temporarily unavailable and the API refused to sign an unverified result.

## Supported Chains (37)

31 EVM chains + Solana + XRP Ledger + Bitcoin + Tron + Stellar + Sui. Includes Ethereum, Base, Polygon, Arbitrum, Optimism, BNB Chain, Avalanche, XDC, Robinhood Chain, Arc, and 21 more EVM. [Full list →](https://insumermodel.com/developers/api-reference/)

## Also Available As

- **Claude Code Skill:** `smithery skill add douglasborthwick/insumer-skill` ([Smithery](https://smithery.ai/skills/douglasborthwick/insumer-skill) · [GitHub](https://github.com/insumerapi/insumer-skill)), for *writing* wallet auth into your own projects from inside Claude Code. This MCP server gives an agent runtime access to the API; insumer-skill helps developers author integration code at build time. Different surfaces, same primitive.
- **ElizaOS Plugin:** `@insumermodel/plugin-eliza` ([npm](https://www.npmjs.com/package/@insumermodel/plugin-eliza))
- **LangChain (Python):** `pip install langchain-insumer` ([PyPI](https://pypi.org/project/langchain-insumer/))
- **OpenAI GPT:** [InsumerAPI Wallet Auth](https://chatgpt.com/g/g-699c5e43ce2481918b3f1e7f144c8a49-insumerapi-wallet-auth) (GPT Store)
- **Verifier (offline JWKS):** `npm install insumer-verify` ([npm](https://www.npmjs.com/package/insumer-verify), [source](https://github.com/insumerapi/insumer-verify))

## Development

```bash
npm install
npm run build

# Test with MCP Inspector
npx @modelcontextprotocol/inspector node build/index.js
```

## License

MIT

---
