#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

const API_BASE = "https://api.insumermodel.com/v1";
const KEYGEN_URL = "https://api.insumermodel.com/v1/keys/create";

const apiKey = process.env.INSUMER_API_KEY ?? "";
// Pay-per-call: with no API key but a funded Base wallet key, metered calls are
// paid inline via x402 (EIP-3009 USDC on Base) — no signup, no credits. Use a
// THROWAWAY wallet funded with a small amount of USDC; each call spends a few
// cents. See the x402 section at https://insumermodel.com/developers.
const paymentKey = (process.env.INSUMER_PAYMENT_KEY ?? "").trim();
const paymentAccount = /^0x[0-9a-fA-F]{64}$/.test(paymentKey)
  ? privateKeyToAccount(paymentKey as `0x${string}`)
  : null;
if (!apiKey && !paymentAccount) {
  console.error("Neither INSUMER_API_KEY nor INSUMER_PAYMENT_KEY set. Use insumer_setup for a free API key, or set INSUMER_PAYMENT_KEY to a funded Base wallet to pay per call via x402.");
}

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// --- Shared API helper ---

async function apiCall(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<{ ok: boolean; data?: unknown; error?: unknown; meta?: unknown }> {
  // Prefer an API key (credits); fall back to x402 pay-per-call if a payment
  // wallet is configured.
  if (!apiKey) {
    if (paymentAccount) return x402Call(method, path, body);
    return { ok: false, error: "No credentials. Call insumer_setup for a free API key, or set INSUMER_PAYMENT_KEY to a funded Base wallet to pay per call." };
  }
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json() as Promise<{
    ok: boolean;
    data?: unknown;
    error?: unknown;
    meta?: unknown;
  }>;
}

// x402 pay-per-call: request the priced 402, sign an EIP-3009 USDC transfer for
// exactly the quoted amount, retry with the X-PAYMENT header. The facilitator
// settles on Base; the wallet needs USDC but no ETH (gasless).
async function x402Call(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<{ ok: boolean; data?: unknown; error?: unknown; meta?: unknown }> {
  if (!paymentAccount) {
    return { ok: false, error: "INSUMER_PAYMENT_KEY is not a valid 0x-prefixed 32-byte private key." };
  }
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const payload = body ? JSON.stringify(body) : undefined;

  // 1. priced quote
  const quoteRes = await fetch(url, { method, headers, body: payload });
  if (quoteRes.status !== 402) {
    return quoteRes.json() as Promise<{ ok: boolean; data?: unknown; error?: unknown; meta?: unknown }>;
  }
  const quote = (await quoteRes.json()) as {
    accepts?: Array<{ amount: string; asset: string; payTo: string; network: string; scheme: string; extra?: { name?: string; version?: string } }>;
    resource?: unknown;
  };
  // The quote lists one entry per settlement network; this client pays on Base only,
  // so pick that entry by network rather than by position.
  const req = quote.accepts?.find((a) => a.network === "eip155:8453");
  if (!req) return { ok: false, error: "x402 quote had no Base (eip155:8453) payment option." };

  // 2. sign EIP-3009 TransferWithAuthorization for exactly the quoted amount
  const now = Math.floor(Date.now() / 1000);
  const auth = {
    from: paymentAccount.address,
    to: req.payTo,
    value: req.amount,
    validAfter: "0",
    validBefore: String(now + 120),
    nonce: ("0x" + randomBytes(32).toString("hex")) as `0x${string}`,
  };
  const signature = await paymentAccount.signTypedData({
    domain: { name: req.extra?.name ?? "USD Coin", version: req.extra?.version ?? "2", chainId: 8453, verifyingContract: BASE_USDC as `0x${string}` },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: auth.from, to: auth.to as `0x${string}`, value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce,
    },
  });

  // 3. retry with the x402 v2 payment header
  const v2 = { x402Version: 2, resource: quote.resource, accepted: req, payload: { signature, authorization: auth } };
  const xPayment = Buffer.from(JSON.stringify(v2)).toString("base64");
  const paidRes = await fetch(url, { method, headers: { ...headers, "X-PAYMENT": xPayment }, body: payload });
  return paidRes.json() as Promise<{ ok: boolean; data?: unknown; error?: unknown; meta?: unknown }>;
}

async function publicApiCall(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<{ ok: boolean; data?: unknown; error?: unknown; meta?: unknown }> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json() as Promise<{
    ok: boolean;
    data?: unknown;
    error?: unknown;
    meta?: unknown;
  }>;
}

function formatResult(result: {
  ok: boolean;
  data?: unknown;
  error?: unknown;
  meta?: unknown;
}) {
  if (result.ok) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    isError: true,
  };
}

// --- Reusable Zod schemas ---

const ChainId = z
  .union([
    z.number().int().describe("EVM chain ID"),
    z.literal("solana"),
    z.literal("xrpl"),
    z.literal("bitcoin"),
    z.literal("tron"),
    z.literal("stellar"),
    z.literal("sui"),
  ])
  .describe("Chain identifier: EVM chain ID (integer, includes 50 for XDC), 'solana', 'xrpl', 'bitcoin', 'tron', 'stellar', or 'sui'");

const OnboardingChainId = z
  .union([
    z.enum(["1", "50", "56", "8453", "43114", "137", "42161", "10", "88888", "1868", "98866", "480", "146", "100", "5000", "534352", "59144", "324", "81457", "42220", "204", "130", "57073", "1329", "80094", "33139", "4663", "167000", "2020", "88", "5042"]).transform(Number),
    z.number().int().refine(
      (n) => [1, 50, 56, 8453, 43114, 137, 42161, 10, 88888, 1868, 98866, 480, 146, 100, 5000, 534352, 59144, 324, 81457, 42220, 204, 130, 57073, 1329, 80094, 33139, 4663, 167000, 2020, 88, 5042].includes(n),
      "Must be a supported onboarding chain"
    ),
    z.literal("solana"),
    z.literal("xrpl"),
  ])
  .describe("Merchant onboarding chain: any of the 31 EVM chain IDs (1, 50 (XDC), 56, 8453, 43114, 137, 42161, 10, 88888, 1868, 98866, 480, 146, 100, 5000, 534352, 59144, 324, 81457, 42220, 204, 130, 57073, 1329, 80094, 33139, 4663 (Robinhood Chain), 167000 (Taiko), 2020 (Ronin), 88 (Viction), 5042 (Arc)), 'solana', or 'xrpl'. Merchant token and NFT configs are not available on Bitcoin, Tron, Stellar or Sui.");

const UsdcChainId = z
  .union([
    z.enum(["1", "8453", "137", "42161", "10", "56", "43114"]).transform(Number),
    z.number().int().refine(
      (n) => [1, 8453, 137, 42161, 10, 56, 43114].includes(n),
      "Must be a supported payment chain"
    ),
    z.literal("solana"),
    z.literal("tron"),
  ])
  .describe("Payment chain: EVM chain ID (1, 8453, 137, 42161, 10, 56, 43114), 'solana', or 'tron'");

const UsdcChainIdWithBitcoin = z
  .union([
    z.enum(["1", "8453", "137", "42161", "10", "56", "43114"]).transform(Number),
    z.number().int().refine(
      (n) => [1, 8453, 137, 42161, 10, 56, 43114].includes(n),
      "Must be a supported payment chain"
    ),
    z.literal("solana"),
    z.literal("bitcoin"),
    z.literal("tron"),
  ])
  .describe("Payment chain: 1, 8453, 137, 42161, 10, 56, 43114, 'solana', 'bitcoin', or 'tron'. EVM/Solana accept USDC and USDT (auto-detected). Bitcoin accepts BTC (converted to USD at market rate). Tron accepts USDT-TRC20.");

const TierSchema = z.object({
  name: z.string().max(30).describe("Tier name, e.g. 'Gold', 'Silver'"),
  threshold: z.number().positive().describe("Minimum token balance for this tier"),
  discount: z.number().int().min(1).max(50).describe("Discount percentage (1-50)"),
});

const TokenConfigSchema = z.object({
  symbol: z.string().max(10).describe("Token symbol, e.g. 'UNI'"),
  chainId: OnboardingChainId,
  contractAddress: z.string().describe("Token contract address. For XRPL: use r-address issuer for trust line tokens, or 'native' for XRP."),
  decimals: z.number().int().min(0).max(18).describe("Token decimals (0-18). Required: the merchant registry stores it with each token and rejects a config without it. 6 for USDC, 18 for most ERC-20s."),
  currency: z.string().optional().describe("XRPL trust line currency code (e.g. 'RLUSD', 'USDC', or 'USD'). Required for XRPL trust line tokens. Standard codes ≤ 3 chars; longer names like 'RLUSD' are auto hex-encoded by the API."),
  tiers: z.array(TierSchema).min(1).max(4).describe("1-4 discount tiers"),
});

const NftCollectionSchema = z.object({
  name: z.string().max(50).describe("NFT collection name"),
  contractAddress: z.string().describe("NFT contract address. For XRPL: use r-address of the NFT issuer."),
  taxon: z.number().int().optional().describe("XRPL NFT taxon for filtering by collection. Optional, XRPL only."),
  chainId: OnboardingChainId,
  discount: z.number().int().min(1).max(50).describe("Discount percentage (1-50)"),
});

// --- Server setup ---

const server = new McpServer({
  name: "insumer",
  version: "1.13.8",
});

// ============================================================
// KEY DISCOVERY
// ============================================================

server.tool(
  "insumer_jwks",
  "Get the JWKS (JSON Web Key Set): five entries over two keys. The ECDSA P-256 key under kids insumer-attest-v1, insumer-attest-v2, and insumer-trust-v2, followed by the ML-DSA-65 post-quantum key under two RFC 9964 AKP entries, insumer-attest-pq1 and insumer-trust-pq1. Use this to verify attestation and trust signatures without hardcoding a key. Match the entry by the kid (or pqKid) on the response, never by position; an unknown kid is unverifiable, not refuted. No authentication required.",
  {},
  async () => {
    const res = await fetch(`${API_BASE}/jwks`);
    const data = await res.json();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }
);

// ============================================================
// SETUP — Generate a free API key (no auth required)
// ============================================================

server.tool(
  "insumer_setup",
  "Generate a free InsumerAPI key instantly. No credit card required. Returns an API key (insr_live_...) with 10 verification credits and 100 calls/day. The user should add the key to their MCP config as INSUMER_API_KEY and restart. One free key per email, 3 per IP per day.",
  {
    email: z.string().email().describe("Email address for the API key"),
    appName: z.string().max(100).optional().describe("Name of your app or project (default: 'MCP Agent')"),
  },
  async (args) => {
    const res = await fetch(KEYGEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: args.email,
        appName: args.appName || "MCP Agent",
        tier: "free",
      }),
    });
    const result = await res.json() as Record<string, unknown>;
    if (result.success && result.key) {
      return {
        content: [{
          type: "text" as const,
          text: [
            `API key generated successfully!`,
            ``,
            `Key: ${result.key}`,
            `Tier: free`,
            `Credits: 10`,
            `Daily limit: 100 calls`,
            ``,
            `To activate, add this to your MCP config:`,
            ``,
            `  "env": { "INSUMER_API_KEY": "${result.key}" }`,
            ``,
            `Then restart your MCP client.`,
          ].join("\n"),
        }],
      };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      isError: true,
    };
  }
);

// ============================================================
// ON-CHAIN VERIFICATION
// ============================================================

server.tool(
  "insumer_attest",
  "Create on-chain verification (attestation). Verify 1-10 conditions (token balances, NFT ownership, EAS attestations, Farcaster identity, arbitrary boolean view calls, supply/amount ratios, ERC-8004 agent registration, ERC-7710 delegation validity) across 37 chains (31 EVM + Solana + XRPL + Bitcoin + Tron + Stellar + Sui). nft_ownership is supported on 33 of the 37 (31 EVM + Solana + XRPL); Bitcoin, Tron, Stellar and Sui are token_balance only. Returns ECDSA-signed boolean results with a kid field identifying the signing key (fetch public key via insumer_jwks). Never exposes actual balances. Each result includes evaluatedCondition (exact logic checked), conditionHash (SHA-256 for tamper-evidence), and blockNumber/blockTimestamp for EVM chains (freshness). XRPL results include ledgerIndex and ledgerHash instead of blockNumber/blockTimestamp; trust line results also include trustLineState: { frozen: boolean }. Stellar results include ledgerIndex and ledgerHash and surface assetCode (which flows into conditionHash for non-native asset binding). Sui results include checkpointSequence and checkpointDigest. Standard mode costs 1 credit. Pass proof: 'merkle' for EIP-1186 Merkle storage proofs (2 credits), available on 27 of the 31 EVM chains. For EAS attestations, use a compliance template (Coinbase Verifications, Gitcoin Passport) or raw schemaId. For Farcaster, use type 'farcaster_id' (checks IdRegistry on Optimism). For arbitrary contract checks, use type 'evm_view_call' (single-address-argument view function returning bool; RPC EVM chains only). For self-scaling agent-spend limits, use type 'ratio_to_amount' (met iff balance >= multiple * amount; RPC EVM chains only). For share-of-supply rules, use type 'ratio_to_supply' (met iff balance / totalSupply >= minFraction, a fraction in (0,1]; RPC EVM chains, ERC-20 only). For agent standing, use type 'erc8004_agent' (is this wallet a registered ERC-8004 agent on Base; agentId required) or 'erc7710_delegation' (is this signed MetaMask-framework delegation from principal to agent currently valid on Base: signature incl. ERC-1271, unrevoked at the anchored block, recognized caveats, time window; spend/target/call limits are REPORTED as declaredLimits, not simulated). Attestations containing a delegation condition expire in 5 minutes instead of 30. On failure a delegation result carries failReason (delegate_mismatch, principal_mismatch, invalid_signature, delegator_not_deployed, revoked, unknown_caveat_enforcer, outside_time_window). Use insumer_compliance_templates to list available templates.",
  {
    wallet: z.string().optional().describe("EVM wallet address (0x...)"),
    solanaWallet: z.string().optional().describe("Solana wallet address (base58)"),
    xrplWallet: z.string().optional().describe("XRPL wallet address (r-address). For verifying XRP, trust line tokens (RLUSD, USDC), or NFTs on XRP Ledger."),
    bitcoinWallet: z.string().optional().describe("Bitcoin address (P2PKH, P2SH, bech32, or Taproot). For verifying native BTC balance. Use chainId 'bitcoin' with contractAddress 'native'."),
    tronWallet: z.string().optional().describe("Tron wallet address (T-prefixed, base58). For verifying TRX or TRC20 tokens (USDT-TRC20). Use chainId 'tron'."),
    stellarWallet: z.string().optional().describe("Stellar wallet address (G-prefixed). For verifying XLM or trustline assets (USDC, BENJI, etc.). Use chainId 'stellar' with the asset issuer's G-address as contractAddress and pass assetCode (e.g. 'USDC'). Soroban contract balances not visible — classic trustlines only."),
    suiWallet: z.string().optional().describe("Sui wallet address (0x + 64 hex chars). For verifying SUI or other Sui coins (e.g. USDC). Use chainId 'sui' with the Sui coin type as contractAddress: '0x2::sui::SUI' for native SUI, or the full coin type address::module::Name for other coins (e.g. '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'). The string 'native' is not accepted on Sui."),
    proof: z.enum(["merkle"]).optional().describe("Set to 'merkle' for EIP-1186 Merkle storage proofs (2 credits). Available for token_balance on 27 of the 31 EVM chains: not on ZKsync Era (324), Sei (1329), Viction (88) or XDC Network (50), and not on any non-EVM chain. Also available for erc7710_delegation as a storage proof of the revocation slot (subject 'delegation_revocation'; managers with an on-chain-verified layout only, currently the v1.3.0 manager on Base)."),
    declaredLimits: z.enum(["omit"]).optional().describe("Set to 'omit' to leave decoded caveat limits out of the signed results of erc7710_delegation conditions, so a forwarded attestation does not carry the principal's spending ceiling. met, delegationHash, and conditionHash are byte-identical either way."),
    format: z.enum(["jwt"]).optional().describe("Set to 'jwt' to include a Wallet Auth by InsumerAPI token (ES256-signed JWT) in the response, with its ML-DSA-65 sibling pqJwt beside it. The jwt is verifiable by any standard JWT library using JWKS at /.well-known/jwks.json."),
    conditions: z
      .array(
        z.object({
          type: z.enum(["token_balance", "nft_ownership", "eas_attestation", "farcaster_id", "evm_view_call", "ratio_to_amount", "ratio_to_supply", "erc8004_agent", "erc7710_delegation"]).describe("Condition type: token_balance, nft_ownership (33 of 37 chains: 31 EVM + Solana + XRPL), eas_attestation, farcaster_id (Farcaster IdRegistry on Optimism), evm_view_call (arbitrary single-address-argument view function returning bool; RPC EVM chains only), ratio_to_amount (balance >= multiple * amount; RPC EVM chains only), ratio_to_supply (balance / totalSupply >= minFraction; RPC EVM chains, ERC-20 only), erc8004_agent (registered ERC-8004 agent on Base; agentId required), or erc7710_delegation (signed MetaMask-framework delegation validity on Base; delegationManager, expectedDelegator, and delegation required; max 3 per request)"),
          contractAddress: z.string().optional().describe("Token or NFT contract address (required for token_balance, nft_ownership, ratio_to_amount, and ratio_to_supply; ratio_to_supply requires an ERC-20 contract, no native). 'native' means the chain's native coin and is for token_balance and ratio_to_amount only. nft_ownership needs the NFT contract address (0x + 40 hex on EVM); 'native' with nft_ownership is rejected with a 400, so use token_balance for the native coin. On Sui, pass a coin type address::module::Name: native SUI is '0x2::sui::SUI', and 'native' is not accepted there."),
          chainId: ChainId.optional(),
          threshold: z.union([z.string(), z.number()]).transform((v) => String(v)).optional().describe("Minimum balance for token_balance, as a decimal string in token/display units (e.g. \"100\", not base units). Numbers are accepted and coerced to a string. Must be > 0 when proof is merkle."),
          multiple: z.union([z.string(), z.number()]).transform((v) => String(v)).optional().describe("For ratio_to_amount: collateralization multiple as a decimal string (e.g. \"10\" for 'hold >= 10x the amount'). Met iff balance >= multiple * amount. Numbers are accepted and coerced. Must be > 0."),
          amount: z.union([z.string(), z.number()]).transform((v) => String(v)).optional().describe("For ratio_to_amount: per-request reference amount in token/display units as a decimal string (e.g. \"100\" for 100 USDC, not base units/wei). Numbers are accepted and coerced. Must be > 0."),
          minFraction: z.union([z.string(), z.number()]).transform((v) => String(v)).optional().describe("For ratio_to_supply: required share of total supply, a decimal string in (0,1] (e.g. \"0.005\" for 0.5%). Met iff balance / totalSupply() >= minFraction. Numbers are accepted and coerced. For project/governance tokens, not stablecoins."),
          decimals: z.number().int().min(0).max(77).optional().describe("Optional. Leave it out: the token's own decimals are always read from the chain. If sent it is only a cross-check, and a value that differs from the token's own decimals is rejected with a 400."),
          label: z.string().max(100).optional().describe("Human-readable label"),
          schemaId: z.string().optional().describe("EAS schema ID (bytes32 hex). Required for eas_attestation unless template is provided."),
          attester: z.string().optional().describe("Expected attester address (optional, for eas_attestation)"),
          indexer: z.string().optional().describe("EAS indexer contract address (optional, for eas_attestation)"),
          template: z.enum(["coinbase_verified_account", "coinbase_verified_country", "coinbase_one", "gitcoin_passport_score", "gitcoin_passport_active"]).optional().describe("Compliance template name. Use instead of raw schemaId/attester/indexer for eas_attestation. Gitcoin Passport templates check Sybil resistance on Optimism."),
          currency: z.string().optional().describe("XRPL trust line currency code (e.g. 'RLUSD', 'USDC'). Required for XRPL trust line tokens, ignored for other chains."),
          assetCode: z.string().optional().describe("Stellar trustline asset code (e.g. 'USDC', 'BENJI'). Required for Stellar non-native (trustline) tokens. Use contractAddress 'native' for XLM. Ignored for other chains. Flows into conditionHash so different assets on the same issuer produce different hashes."),
          taxon: z.number().int().optional().describe("XRPL NFToken taxon filter (optional, for nft_ownership on XRPL only). Filters NFTs by issuer + taxon."),
          selector: z.string().optional().describe("Required for evm_view_call. Canonical signature of a view function returning bool, in the form 'functionName(address)' (e.g. 'hasAccess(address)'). v1 supports single-address-argument view functions only; the 4-byte selector is derived from this signature."),
          agentId: z.string().optional().describe("Required for erc8004_agent. The ERC-8004 agent ID as a uint256 decimal string — the caller must supply it (the deployed Identity Registry has no wallet-to-agentId reverse lookup). Met iff the attested wallet owns the agent NFT (ownerOf) or is the registry's signature-verified agentWallet binding. Registry 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 on Base; chainId 8453 only. Honest semantics: registration is permissionless minting — the signed statement implies no vetting, no reputation, no endorsement."),
          delegationManager: z.string().optional().describe("Required for erc7710_delegation. DelegationManager contract the delegation was signed against — one of the three recognized MetaMask Delegation Framework managers on Base (1.0.0 / 1.1.0 / 1.3.0; current default 0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3). chainId 8453 only."),
          expectedDelegator: z.string().optional().describe("Required for erc7710_delegation. The principal address the caller asserts authorized this agent. The condition fails unless the delegation's declared delegator matches — without it a self-delegation would read as authority, so there is no structural-only mode."),
          delegation: z.object({
            delegator: z.string().describe("Principal address that signed the delegation. Must equal expectedDelegator."),
            delegate: z.string().describe("Agent wallet the delegation authorizes. Must equal the attested wallet."),
            authority: z.string().describe("Root authority only (0xffff…ffff, 32 bytes of 0xff). Delegation chains are unsupported in v1."),
            caveats: z.array(z.object({
              enforcer: z.string().describe("Caveat enforcer contract address"),
              terms: z.string().describe("ABI-encoded caveat terms (hex)"),
            })).max(16).describe("Caveats the principal signed (max 16). Every enforcer must be recognized or the condition fails — no override."),
            salt: z.union([z.string(), z.number()]).transform((v) => String(v)).describe("Delegation salt (decimal string; numbers coerced)"),
            signature: z.string().describe("EIP-712 signature over the delegation (hex). EOA recovery, or ERC-1271 for smart-contract principals."),
          }).optional().describe("Required for erc7710_delegation. The signed ERC-7710 delegation to evaluate. Met iff ALL of: attested wallet is the delegate; declared delegator is expectedDelegator; EIP-712 signature verifies (EOA or ERC-1271); unrevoked at the anchored block; every caveat enforcer recognized; any time-window caveat currently satisfied. Recognized enforcers (5): timestamp (evaluated), erc20_transfer_amount, native_transfer_amount, allowed_targets, limited_calls (the last four are REPORTED as declaredLimits — redemption enforces them, the attestation does not simulate enforcement)."),
        })
      )
      .min(1)
      .max(10)
      .describe("1-10 on-chain conditions to verify"),
  },
  async (args) => {
    const result = await apiCall("POST", "/attest", args);
    return formatResult(result);
  }
);

server.tool(
  "insumer_compliance_templates",
  "List available compliance templates for EAS attestation verification. Templates provide pre-configured schema IDs, attester addresses, and decoder contracts for KYC/identity providers (Coinbase Verifications on Base, Gitcoin Passport on Optimism). Use a template name in insumer_attest conditions instead of specifying raw EAS parameters. No authentication or credits required.",
  {},
  async () => {
    const url = `${API_BASE}/compliance/templates`;
    const res = await fetch(url, {
      method: "GET",
      headers: { "Accept": "application/json" },
    });
    const result = await res.json() as { ok: boolean; data?: unknown; error?: unknown; meta?: unknown };
    return formatResult(result);
  }
);

server.tool(
  "insumer_wallet_trust",
  "Generate a structured, ECDSA-signed wallet trust fact profile. Send an EVM wallet address and get 145 base checks across 27 chains in 9 dimensions: stablecoins (USDC, USDT, OUSD, PYUSD, USDG, USD1, RLUSD, USDS, DAI and EURC across 23 EVM chains), governance (UNI, AAVE, ARB, OP, ENS, LDO, SKY, COMP), NFTs (BAYC, Pudgy Penguins, Wrapped CryptoPunks), staking (stETH, rETH, cbETH, wstETH, weETH), institutional stablecoins (EURCV, USDCV, USDC and BENJI across Ethereum, Solana, XRPL, Stellar and Sui), tokenized treasuries (BUIDL, USYC, OUSG, USTB, USDY), stablecoin deposits (Aave v3 aUSDC/aUSDT, sUSDS, sDAI, listed Morpho USDC vaults), wrapped bitcoin (cbBTC, WBTC, tBTC) and names (ENS .eth, Basenames). Rows on Solana, XRPL, Stellar and Sui inside those dimensions evaluate only when the matching optional wallet is supplied; otherwise they stay in the signed profile with evaluated: false. Add optional Solana, XRPL, Bitcoin and Tron wallets to reach up to 166 checks across 29 chains in 13 dimensions (adds a 14-check Solana dimension, RLUSD + USDC + OUSG on XRPL, native BTC holdings, and USDT + USD1 + WBTC on Tron). Every check is a presence check: held or not held, never a balance. The signed conditionSetVersion (currently 2026-10) names the check list that was run; log it, never reject on it. Returns per-dimension pass/fail counts and an overall summary: no score, no opinion, just cryptographically verifiable evidence organized by dimension. Designed for AI agent-to-agent trust decisions. Costs 3 credits (standard) or 6 credits (proof: 'merkle').",
  {
    wallet: z.string().describe("EVM wallet address (0x...) to profile"),
    solanaWallet: z.string().optional().describe("Solana wallet address (base58). If provided, adds the 14-check solana dimension (USDC, EURC, OUSD, PYUSD, USD1, USDG, USDS, BUIDL, USDY, WBTC, cbBTC, tBTC, JitoSOL, mSOL) and lets the institutional EURCV/USDCV on Solana rows evaluate."),
    xrplWallet: z.string().optional().describe("XRPL wallet address (r-address). If provided, adds the xrpl dimension (RLUSD, USDC, OUSG) and lets the institutional EURCV on XRPL row evaluate."),
    bitcoinWallet: z.string().optional().describe("Bitcoin address. If provided, adds the bitcoin dimension (one native BTC presence check)."),
    tronWallet: z.string().optional().describe("Tron wallet address (T-prefixed). If provided, adds the tron dimension (USDT, USD1, WBTC on Tron)."),
    stellarWallet: z.string().optional().describe("Stellar wallet address (G-prefixed). If provided, lets the institutional USDC and BENJI on Stellar rows evaluate (classic trustlines). Adds no dimension."),
    suiWallet: z.string().optional().describe("Sui wallet address (0x + 64 hex). If provided, lets the institutional USDC on Sui and tokenized-treasury USDY on Sui rows evaluate. Adds no dimension."),
    proof: z.enum(["merkle"]).optional().describe("Set to 'merkle' for EIP-1186 Merkle storage proofs on EVM token checks (6 credits). Rows whose balance is computed rather than stored (Aave aTokens, BUIDL) and NFT/non-EVM rows are declined with a reason; the premium is refunded whenever no proof is delivered."),
  },
  async (args) => {
    const result = await apiCall("POST", "/trust", args);
    return formatResult(result);
  }
);

server.tool(
  "insumer_batch_wallet_trust",
  "Generate wallet trust fact profiles for up to 10 wallets in a single request. Shared block fetches make this 5-8x faster than sequential calls. Each wallet gets an independently ECDSA-signed profile with its own TRST-XXXXX ID. Supports partial success — failed wallets get error entries while successful ones return full profiles. Costs 3 credits per successful wallet (standard) or 6 credits per wallet (proof: 'merkle'). Credits only charged for successful profiles.",
  {
    wallets: z
      .array(
        z.object({
          wallet: z.string().describe("EVM wallet address (0x...)"),
          solanaWallet: z
            .string()
            .optional()
            .describe("Solana wallet address (base58). Adds the 14-check solana dimension and lets the institutional EURCV/USDCV on Solana rows evaluate."),
          xrplWallet: z
            .string()
            .optional()
            .describe("XRPL wallet address (r-address). Adds the xrpl dimension (RLUSD, USDC, OUSG) and lets the institutional EURCV on XRPL row evaluate."),
          bitcoinWallet: z
            .string()
            .optional()
            .describe("Bitcoin address. Adds the bitcoin dimension (native BTC)."),
          tronWallet: z
            .string()
            .optional()
            .describe("Tron wallet address (T-prefixed). Adds the tron dimension (USDT, USD1, WBTC)."),
          stellarWallet: z
            .string()
            .optional()
            .describe("Stellar wallet address (G-prefixed). Lets the institutional USDC and BENJI on Stellar rows evaluate; adds no dimension."),
          suiWallet: z
            .string()
            .optional()
            .describe("Sui wallet address (0x + 64 hex). Lets the institutional USDC on Sui and USDY on Sui rows evaluate; adds no dimension."),
        })
      )
      .min(1)
      .max(10)
      .describe("1-10 wallet entries to profile"),
    proof: z
      .enum(["merkle"])
      .optional()
      .describe(
        "Set to 'merkle' for EIP-1186 Merkle storage proofs on all wallets (6 credits/wallet)."
      ),
  },
  async (args) => {
    const result = await apiCall("POST", "/trust/batch", args);
    return formatResult(result);
  }
);

server.tool(
  "insumer_verify",
  "Create signed discount code (INSR-XXXXX, 30-min expiry) for a wallet at a merchant. Returns tier and discount percentage — never raw balance amounts. Consumes 1 merchant credit. If merchant has Stripe Connect, a coupon is auto-created.",
  {
    merchantId: z.string().describe("Merchant ID"),
    wallet: z.string().optional().describe("EVM wallet address (0x...)"),
    solanaWallet: z.string().optional().describe("Solana wallet address (base58)"),
    xrplWallet: z.string().optional().describe("XRPL wallet address (r-address)"),
    tronWallet: z.string().optional().describe("Tron wallet address (T-prefixed)"),
    stellarWallet: z.string().optional().describe("Stellar wallet address (G-prefixed)"),
    suiWallet: z.string().optional().describe("Sui wallet address (0x + 64 hex)"),
  },
  async (args) => {
    const result = await apiCall("POST", "/verify", args);
    return formatResult(result);
  }
);

// ============================================================
// DISCOVERY
// ============================================================

server.tool(
  "insumer_list_merchants",
  "Browse merchants in the public directory. Filter by accepted token, verification status. Returns company name, website, tokens accepted, and discount info.",
  {
    token: z.string().optional().describe("Filter by accepted token symbol, e.g. 'UNI'"),
    verified: z.enum(["true", "false"]).optional().describe("Filter by domain verification status"),
    limit: z.number().int().min(1).max(200).optional().describe("Results per page (default 50, max 200)"),
    offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)"),
  },
  async (args) => {
    const params = new URLSearchParams();
    if (args.token) params.set("token", args.token);
    if (args.verified) params.set("verified", args.verified);
    if (args.limit !== undefined) params.set("limit", String(args.limit));
    if (args.offset !== undefined) params.set("offset", String(args.offset));
    const qs = params.toString();
    const url = `${API_BASE}/merchants${qs ? `?${qs}` : ""}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { "Accept": "application/json" },
    });
    const result = await res.json() as { ok: boolean; data?: unknown; error?: unknown; meta?: unknown };
    return formatResult(result);
  }
);

server.tool(
  "insumer_get_merchant",
  "Get full public merchant profile including token tiers, NFT collections, discount mode, and verification status.",
  {
    id: z.string().describe("Merchant ID"),
  },
  async (args) => {
    const url = `${API_BASE}/merchants/${encodeURIComponent(args.id)}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { "Accept": "application/json" },
    });
    const result = await res.json() as { ok: boolean; data?: unknown; error?: unknown; meta?: unknown };
    return formatResult(result);
  }
);

server.tool(
  "insumer_list_tokens",
  "List all registered tokens and NFT collections in the Insumer registry. Filter by chain, symbol, or asset type.",
  {
    chain: z.union([z.number().int(), z.literal("solana"), z.literal("xrpl"), z.literal("bitcoin")]).optional().describe("Filter by chain ID"),
    symbol: z.string().optional().describe("Filter by token symbol"),
    type: z.enum(["token", "nft"]).optional().describe("Filter by asset type"),
  },
  async (args) => {
    const params = new URLSearchParams();
    if (args.chain !== undefined) params.set("chain", String(args.chain));
    if (args.symbol) params.set("symbol", args.symbol);
    if (args.type) params.set("type", args.type);
    const qs = params.toString();
    const url = `${API_BASE}/tokens${qs ? `?${qs}` : ""}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { "Accept": "application/json" },
    });
    const result = await res.json() as { ok: boolean; data?: unknown; error?: unknown; meta?: unknown };
    return formatResult(result);
  }
);

server.tool(
  "insumer_check_discount",
  "Calculate discount for a wallet at a merchant. Checks on-chain balances and returns tier and discount percentage per token — never raw balance amounts. Free — does not consume credits.",
  {
    merchant: z.string().describe("Merchant ID"),
    wallet: z.string().optional().describe("EVM wallet address (0x...)"),
    solanaWallet: z.string().optional().describe("Solana wallet address (base58)"),
    xrplWallet: z.string().optional().describe("XRPL wallet address (r-address)"),
    tronWallet: z.string().optional().describe("Tron wallet address (T-prefixed)"),
    stellarWallet: z.string().optional().describe("Stellar wallet address (G-prefixed)"),
    suiWallet: z.string().optional().describe("Sui wallet address (0x + 64 hex)"),
  },
  async (args) => {
    const params = new URLSearchParams();
    params.set("merchant", args.merchant);
    if (args.wallet) params.set("wallet", args.wallet);
    if (args.solanaWallet) params.set("solanaWallet", args.solanaWallet);
    if (args.xrplWallet) params.set("xrplWallet", args.xrplWallet);
    if (args.tronWallet) params.set("tronWallet", args.tronWallet);
    if (args.stellarWallet) params.set("stellarWallet", args.stellarWallet);
    if (args.suiWallet) params.set("suiWallet", args.suiWallet);
    const url = `${API_BASE}/discount/check?${params.toString()}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { "Accept": "application/json" },
    });
    const result = await res.json() as { ok: boolean; data?: unknown; error?: unknown; meta?: unknown };
    return formatResult(result);
  }
);

// ============================================================
// CREDITS
// ============================================================

server.tool(
  "insumer_credits",
  "Check verification credit balance, tier (free/pro/enterprise), and daily rate limit for the current API key.",
  {},
  async () => {
    const result = await apiCall("GET", "/credits");
    return formatResult(result);
  }
);

server.tool(
  "insumer_buy_key",
  "Buy a new API key with USDC, USDT, BTC, or USDT-TRC20 (no auth required). Agent-friendly: no email needed. Send USDC/USDT to EVM wallet 0xAd982CB19aCCa2923Df8F687C0614a7700255a23 or Solana wallet 6a1mLjefhvSJX1sEX8PTnionbE9DqoYjU6F6bNkT4Ydr. Send USDT-TRC20 to Tron wallet TC5yvwkAMakkXtUxYiu2Yn1xbBcwYuD6cn. Send BTC to bc1qg7qnerdhlmdn899zemtez5tcx2a2snc0dt9dt0 (1 confirmation required). USDC/USDT auto-detected from transaction. BTC converted to USD at market rate. One key per wallet — use insumer_buy_credits to top up. Volume discounts: $5–$99 = $0.04/call, $100–$499 = $0.03, $500+ = $0.02. Non-refundable.",
  {
    txHash: z.string().describe("Transaction hash proving payment"),
    chainId: UsdcChainIdWithBitcoin,
    amount: z.number().min(5).optional().describe("Stablecoin amount sent (minimum 5). Not required for BTC — USD value derived from on-chain amount at market rate."),
    appName: z.string().max(100).describe("Name for the API key (e.g. your agent or app name)"),
  },
  async (args) => {
    const result = await publicApiCall("POST", "/keys/buy", args);
    return formatResult(result);
  }
);

server.tool(
  "insumer_buy_credits",
  "Buy verification credits with USDC, USDT, BTC, or USDT-TRC20. Volume discounts: $5–$99 = $0.04/call (25 credits/$1), $100–$499 = $0.03 (33/$1, 25% off), $500+ = $0.02 (50/$1, 50% off). Minimum $5. USDC/USDT on EVM and Solana (auto-detected). USDT-TRC20 on Tron. BTC on Bitcoin (converted to USD at market rate, 1 confirmation required). Crypto sent on unsupported chains cannot be recovered. Non-refundable. First purchase registers the sender wallet to the API key. Subsequent purchases must come from the same sender. To change the registered wallet, set updateWallet to true.",
  {
    txHash: z.string().describe("Transaction hash proving payment"),
    chainId: UsdcChainIdWithBitcoin,
    amount: z.number().min(5).optional().describe("Stablecoin amount sent (minimum 5). Not required for BTC."),
    updateWallet: z.boolean().optional().default(false).describe("Set true to update the registered sender wallet to this transaction's sender"),
  },
  async (args) => {
    const result = await apiCall("POST", "/credits/buy", args);
    return formatResult(result);
  }
);

server.tool(
  "insumer_confirm_payment",
  "Confirm stablecoin payment for a discount code. After calling insumer_verify, confirm that the USDC/USDT payment was made on-chain. The server verifies the transaction receipt.",
  {
    code: z.string().describe("Verification code from insumer_verify (e.g. INSR-A7K3M)"),
    txHash: z.string().describe("On-chain transaction hash or Solana signature"),
    chainId: UsdcChainId,
    amount: z.union([z.string(), z.number()]).describe("Stablecoin amount sent"),
  },
  async (args) => {
    const result = await apiCall("POST", "/payment/confirm", args);
    return formatResult(result);
  }
);

// ============================================================
// MERCHANT ONBOARDING
// ============================================================

server.tool(
  "insumer_create_merchant",
  "Create a new merchant. Receives 100 free verification credits. The API key that creates the merchant owns it. Max 10 merchants per API key.",
  {
    companyName: z.string().max(100).describe("Company display name"),
    companyId: z
      .string()
      .min(2)
      .max(50)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .describe("Unique merchant ID (alphanumeric, dashes, underscores)"),
    location: z.string().max(200).optional().describe("City or region"),
  },
  async (args) => {
    const result = await apiCall("POST", "/merchants", args);
    return formatResult(result);
  }
);

server.tool(
  "insumer_merchant_status",
  "Get full private merchant details: credits, token configs, NFT collections, directory status, verification status, payment settings. Owner only.",
  {
    id: z.string().describe("Merchant ID"),
  },
  async (args) => {
    const result = await apiCall(
      "GET",
      `/merchants/${encodeURIComponent(args.id)}/status`
    );
    return formatResult(result);
  }
);

server.tool(
  "insumer_configure_tokens",
  "Configure merchant token discount tiers. Set own token and/or partner tokens. Max 8 tokens total. Owner only.",
  {
    id: z.string().describe("Merchant ID"),
    ownToken: TokenConfigSchema.nullable()
      .optional()
      .describe("Merchant's own token configuration, or null to remove"),
    partnerTokens: z
      .array(TokenConfigSchema)
      .optional()
      .describe("Partner token configurations"),
  },
  async (args) => {
    const { id, ...body } = args;
    const result = await apiCall(
      "PUT",
      `/merchants/${encodeURIComponent(id)}/tokens`,
      body
    );
    return formatResult(result);
  }
);

server.tool(
  "insumer_configure_nfts",
  "Configure NFT collections that grant discounts at the merchant. Max 4 collections. Owner only.",
  {
    id: z.string().describe("Merchant ID"),
    nftCollections: z
      .array(NftCollectionSchema)
      .min(0)
      .max(4)
      .describe("NFT collection configurations (0-4)"),
  },
  async (args) => {
    const { id, ...body } = args;
    const result = await apiCall(
      "PUT",
      `/merchants/${encodeURIComponent(id)}/nfts`,
      body
    );
    return formatResult(result);
  }
);

server.tool(
  "insumer_configure_settings",
  "Update merchant settings: discount stacking mode, cap, and stablecoin payment configuration. All fields optional. Owner only.",
  {
    id: z.string().describe("Merchant ID"),
    discountMode: z
      .enum(["highest", "stack", "capped"])
      .optional()
      .describe("'highest' uses best single discount, 'stack' adds them together, 'capped' stacks up to discountCap"),
    discountCap: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Maximum total discount percentage (1-100)"),
    usdcPayment: z
      .object({
        enabled: z.boolean().describe("Enable or disable USDC payments"),
        evmAddress: z.string().optional().describe("EVM wallet for USDC (0x...)"),
        solanaAddress: z.string().optional().describe("Solana wallet for USDC"),
        preferredChainId: UsdcChainId.optional().describe("Preferred USDC chain"),
      })
      .nullable()
      .optional()
      .describe("USDC payment settings, or null to disable"),
  },
  async (args) => {
    const { id, ...body } = args;
    const result = await apiCall(
      "PUT",
      `/merchants/${encodeURIComponent(id)}/settings`,
      body
    );
    return formatResult(result);
  }
);

server.tool(
  "insumer_publish_directory",
  "Publish (or refresh) the merchant's listing in the public directory. Call again after updating tokens or settings. Owner only.",
  {
    id: z.string().describe("Merchant ID"),
  },
  async (args) => {
    const result = await apiCall(
      "POST",
      `/merchants/${encodeURIComponent(args.id)}/directory`,
      {}
    );
    return formatResult(result);
  }
);

server.tool(
  "insumer_buy_merchant_credits",
  "Buy merchant verification credits with USDC, USDT, BTC, or USDT-TRC20. Volume discounts: $5–$99 = $0.04/call (25/$1), $100–$499 = $0.03 (33/$1), $500+ = $0.02 (50/$1). Minimum $5. USDC/USDT on EVM and Solana (auto-detected). USDT-TRC20 on Tron. BTC on Bitcoin (converted to USD at market rate, 1 confirmation required). Non-refundable. Owner only. First purchase registers the sender wallet to the API key. To change the registered wallet, set updateWallet to true.",
  {
    id: z.string().describe("Merchant ID"),
    txHash: z.string().describe("Transaction hash proving payment"),
    chainId: UsdcChainIdWithBitcoin,
    amount: z.number().min(5).optional().describe("Stablecoin amount sent (minimum 5). Not required for BTC."),
    updateWallet: z.boolean().optional().default(false).describe("Set true to update the registered sender wallet"),
  },
  async (args) => {
    const { id, ...body } = args;
    const result = await apiCall(
      "POST",
      `/merchants/${encodeURIComponent(id)}/credits`,
      body
    );
    return formatResult(result);
  }
);

// ============================================================
// DOMAIN VERIFICATION
// ============================================================

server.tool(
  "insumer_request_domain_verification",
  "Request a domain verification token for a merchant. Returns the token and three verification methods: DNS TXT record, HTML meta tag, or file upload. After placing the token, call insumer_verify_domain to complete verification. Verified merchants get a trust badge in the public directory. Owner only.",
  {
    id: z.string().describe("Merchant ID"),
    domain: z.string().describe("Domain to verify (e.g. 'example.com')"),
  },
  async (args) => {
    const { id, ...body } = args;
    const result = await apiCall(
      "POST",
      `/merchants/${encodeURIComponent(id)}/domain-verification`,
      body
    );
    return formatResult(result);
  }
);

server.tool(
  "insumer_verify_domain",
  "Verify domain ownership for a merchant. Call this after placing the verification token (from insumer_request_domain_verification) via DNS TXT record, HTML meta tag, or file upload. The server checks all three methods automatically. Rate limited to 5 attempts per hour. Owner only.",
  {
    id: z.string().describe("Merchant ID"),
  },
  async (args) => {
    const result = await apiCall(
      "PUT",
      `/merchants/${encodeURIComponent(args.id)}/domain-verification`
    );
    return formatResult(result);
  }
);

// ============================================================
// COMMERCE PROTOCOL INTEGRATION
// ============================================================

server.tool(
  "insumer_acp_discount",
  "Check token-holder discount eligibility in OpenAI/Stripe Agentic Commerce Protocol (ACP) format. Returns coupon objects, applied/rejected arrays, and per-item allocations compatible with ACP checkout flows. Same on-chain verification as insumer_verify, wrapped in ACP format. Consumes 1 merchant credit.",
  {
    merchantId: z.string().describe("Merchant ID"),
    wallet: z.string().optional().describe("EVM wallet address (0x...)"),
    solanaWallet: z.string().optional().describe("Solana wallet address (base58)"),
    xrplWallet: z.string().optional().describe("XRPL wallet address (r-address)"),
    tronWallet: z.string().optional().describe("Tron wallet address (T-prefixed)"),
    stellarWallet: z.string().optional().describe("Stellar wallet address (G-prefixed)"),
    suiWallet: z.string().optional().describe("Sui wallet address (0x + 64 hex)"),
    items: z
      .array(
        z.object({
          path: z.string().describe("JSONPath reference to the line item, e.g. '$.line_items[0]'"),
          amount: z.number().int().describe("Item price in cents"),
        })
      )
      .optional()
      .describe("Optional line items for per-item cent-amount allocations"),
  },
  async (args) => {
    const result = await apiCall("POST", "/acp/discount", args);
    return formatResult(result);
  }
);

server.tool(
  "insumer_ucp_discount",
  "Check token-holder discount eligibility in Google Universal Commerce Protocol (UCP) format. Returns title, extension field, and applied array compatible with UCP checkout flows. Same on-chain verification as insumer_verify, wrapped in UCP format. Consumes 1 merchant credit.",
  {
    merchantId: z.string().describe("Merchant ID"),
    wallet: z.string().optional().describe("EVM wallet address (0x...)"),
    solanaWallet: z.string().optional().describe("Solana wallet address (base58)"),
    xrplWallet: z.string().optional().describe("XRPL wallet address (r-address)"),
    tronWallet: z.string().optional().describe("Tron wallet address (T-prefixed)"),
    stellarWallet: z.string().optional().describe("Stellar wallet address (G-prefixed)"),
    suiWallet: z.string().optional().describe("Sui wallet address (0x + 64 hex)"),
    items: z
      .array(
        z.object({
          path: z.string().describe("JSONPath reference to the line item, e.g. '$.line_items[0]'"),
          amount: z.number().int().describe("Item price in cents"),
        })
      )
      .optional()
      .describe("Optional line items for per-item cent-amount allocations"),
  },
  async (args) => {
    const result = await apiCall("POST", "/ucp/discount", args);
    return formatResult(result);
  }
);

server.tool(
  "insumer_validate_code",
  "Validate an INSR-XXXXX discount code. For merchant backends during ACP/UCP checkout to confirm code validity, discount percent, and expiry. Returns valid/invalid status with reason. No authentication required, no credits consumed. Does not expose wallet or token data.",
  {
    code: z.string().regex(/^INSR-[A-Z0-9]{5}$/).describe("Discount code in INSR-XXXXX format"),
  },
  async (args) => {
    const res = await fetch(`${API_BASE}/codes/${encodeURIComponent(args.code)}`);
    const data = await res.json();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }
);

// --- Start server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
