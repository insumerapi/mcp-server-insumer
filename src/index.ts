#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import {
  BASE_NETWORK,
  BASE_USDC,
  DEFAULT_MAX_PAYMENT_USDC,
  MIN_CALL_PRICE_UNITS,
  checkQuote,
  parseUsdcCap,
  type QuoteEntry,
} from "./payment-guard.js";

const VERSION = "1.14.1";
const API_BASE = "https://api.insumermodel.com/v1";
const KEYGEN_URL = "https://api.insumermodel.com/v1/keys/create";

const apiKey = process.env.INSUMER_API_KEY ?? "";
// Pay-per-call: with no API key but a funded Base wallet key, metered calls are
// paid inline via x402 (EIP-3009 USDC on Base) — no signup, no credits. Use a
// THROWAWAY wallet funded with a small amount of USDC. Each quote is checked
// before signing (see payment-guard.ts): InsumerAPI's own receiving address,
// USDC on Base, and no more than INSUMER_MAX_PAYMENT_USDC per call.
const paymentKey = (process.env.INSUMER_PAYMENT_KEY ?? "").trim();
const paymentAccount = /^0x[0-9a-fA-F]{64}$/.test(paymentKey)
  ? privateKeyToAccount(paymentKey as `0x${string}`)
  : null;
if (!apiKey && !paymentAccount) {
  console.error("Neither INSUMER_API_KEY nor INSUMER_PAYMENT_KEY set. Use insumer_setup for a free API key, or set INSUMER_PAYMENT_KEY to a funded Base wallet to pay per call via x402.");
}

// The payment cap. A malformed value is never replaced by the default: payments
// are refused until it is fixed.
let paymentCapUnits: bigint | null = null;
let paymentCapError: string | null = null;
try {
  paymentCapUnits = parseUsdcCap(process.env.INSUMER_MAX_PAYMENT_USDC ?? DEFAULT_MAX_PAYMENT_USDC);
  if (paymentAccount && paymentCapUnits < MIN_CALL_PRICE_UNITS) {
    console.error("INSUMER_MAX_PAYMENT_USDC is below the cheapest paid call ($0.05), so every paid call will be refused.");
  }
} catch (err) {
  paymentCapError = (err as Error).message;
  if (paymentAccount) console.error(`${paymentCapError} Pay-per-call is disabled until it is fixed.`);
}

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

// x402 pay-per-call: request the priced 402, check the quote, sign an EIP-3009
// USDC transfer for exactly the quoted amount, retry with the payment header.
// The facilitator settles on Base; the wallet needs USDC but no ETH (gasless).
async function x402Call(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<{ ok: boolean; data?: unknown; error?: unknown; meta?: unknown }> {
  if (!paymentAccount) {
    return { ok: false, error: "INSUMER_PAYMENT_KEY is not a valid 0x-prefixed 32-byte private key." };
  }
  if (paymentCapUnits === null) {
    return { ok: false, error: paymentCapError ?? "Payment cap is not set." };
  }
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const payload = body ? JSON.stringify(body) : undefined;

  // 1. priced quote
  const quoteRes = await fetch(url, { method, headers, body: payload });
  if (quoteRes.status !== 402) {
    return quoteRes.json() as Promise<{ ok: boolean; data?: unknown; error?: unknown; meta?: unknown }>;
  }
  const quote = (await quoteRes.json()) as { accepts?: QuoteEntry[]; resource?: unknown };
  // The quote lists one entry per settlement network; this client pays on Base only,
  // so pick that entry by network rather than by position.
  const req = quote.accepts?.find((a) => a.network === BASE_NETWORK);
  if (!req) return { ok: false, error: `x402 quote had no Base (${BASE_NETWORK}) payment option.` };

  // 2. refuse anything but InsumerAPI's own receiving address, USDC on Base, within the cap
  const check = checkQuote(req, paymentCapUnits);
  if (!check.ok) return { ok: false, error: check.error };

  // 3. sign EIP-3009 TransferWithAuthorization for exactly the quoted amount
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

  // 4. retry with the x402 v2 payment header
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

// --- Input formats ---
// Every free-text input has a format and a length limit. The API validates
// again server-side; these reject malformed input before any request is sent.

const B58 = "1-9A-HJ-NP-Za-km-z";
const EvmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "EVM address: 0x followed by 40 hex characters");
const SolanaAddress = z.string().regex(new RegExp(`^[${B58}]{32,44}$`), "Solana address: base58, 32-44 characters");
const XrplAddress = z.string().regex(new RegExp(`^r[${B58}]{24,34}$`), "XRPL address: r-address");
const BitcoinAddress = z
  .string()
  .regex(new RegExp(`^(?:[13][${B58}]{25,34}|(?:bc1|BC1)[02-9ac-hj-np-zAC-HJ-NP-Z]{11,87})$`), "Bitcoin address: P2PKH, P2SH, bech32 or Taproot");
const TronAddress = z.string().regex(new RegExp(`^T[${B58}]{33}$`), "Tron address: T-prefixed base58");
const StellarAddress = z.string().regex(/^G[A-Z2-7]{55}$/, "Stellar address: G-prefixed, 56 characters");
const SuiAddress = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "Sui address: 0x followed by 64 hex characters");
const Bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "0x followed by 64 hex characters");
const HexData = (max: number) => z.string().max(max).regex(/^0x[0-9a-fA-F]*$/, "0x-prefixed hex");
const MerchantId = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/, "Merchant ID: letters, digits, dashes, underscores");
const TxHash = z
  .string()
  .max(100)
  .regex(new RegExp(`^(?:0x[0-9a-fA-F]{64}|[0-9a-fA-F]{64}|[${B58}]{43,90})$`), "Transaction hash (0x + 64 hex, 64 hex, or a base58 Solana signature)");
const DiscountCode = z.string().regex(/^INSR-[A-Z0-9]{5}$/, "Discount code in INSR-XXXXX format");
// Token/NFT reference: an EVM, Solana, XRPL or Stellar address, a Sui coin type
// (address::module::Name), or 'native'.
const ContractRef = z.string().min(1).max(200).regex(/^[A-Za-z0-9:_]+$/, "Contract address, coin type, or 'native'");
const DecimalString = z.string().max(80).regex(/^\d+(\.\d+)?$/, "Decimal string, e.g. \"100\" or \"0.5\"");
const DecimalArg = z.union([DecimalString, z.number()]).transform((v) => String(v));
const UintString = z.string().regex(/^\d{1,78}$/, "Unsigned integer as a decimal string");
const ShortText = (max: number) => z.string().max(max);
const Domain = z
  .string()
  .max(253)
  .regex(/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})$/, "Domain name, e.g. example.com");

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
  .describe("Merchant onboarding chain: one of the EVM chain IDs listed in this schema, 'solana', or 'xrpl'. Merchant token and NFT configs are not available on Bitcoin, Tron, Stellar or Sui.");

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
  contractAddress: ContractRef.describe("Token contract address. For XRPL: use r-address issuer for trust line tokens, or 'native' for XRP."),
  decimals: z.number().int().min(0).max(18).describe("Token decimals (0-18). Required: the merchant registry stores it with each token and rejects a config without it. 6 for USDC, 18 for most ERC-20s."),
  currency: z.string().max(40).regex(/^[A-Za-z0-9]+$/).optional().describe("XRPL trust line currency code (e.g. 'RLUSD', 'USDC', or 'USD'). Required for XRPL trust line tokens. Standard codes ≤ 3 chars; longer names like 'RLUSD' are auto hex-encoded by the API."),
  tiers: z.array(TierSchema).min(1).max(4).describe("1-4 discount tiers"),
});

const NftCollectionSchema = z.object({
  name: z.string().max(50).describe("NFT collection name"),
  contractAddress: ContractRef.describe("NFT contract address. For XRPL: use r-address of the NFT issuer."),
  taxon: z.number().int().optional().describe("XRPL NFT taxon for filtering by collection. Optional, XRPL only."),
  chainId: OnboardingChainId,
  discount: z.number().int().min(1).max(50).describe("Discount percentage (1-50)"),
});

// Optional wallet fields shared by the verification and discount tools.
const WalletFields = {
  wallet: EvmAddress.optional().describe("EVM wallet address (0x...)"),
  solanaWallet: SolanaAddress.optional().describe("Solana wallet address (base58)"),
  xrplWallet: XrplAddress.optional().describe("XRPL wallet address (r-address)"),
  tronWallet: TronAddress.optional().describe("Tron wallet address (T-prefixed)"),
  stellarWallet: StellarAddress.optional().describe("Stellar wallet address (G-prefixed)"),
  suiWallet: SuiAddress.optional().describe("Sui wallet address (0x + 64 hex)"),
};

const COUNTS_NOTE = "Current chain and check counts: https://insumermodel.com/llms.txt";
const PRICING_NOTE = "Current prices and volume discounts: https://insumermodel.com/pricing/";

// --- Tool annotations ---
// Every tool reaches the InsumerAPI service over the network (openWorldHint).
// Read-only means the call changes nothing and spends nothing; calls that spend
// credits or a payment, or that create or change records, are not marked
// read-only. Tools that overwrite existing configuration are marked destructive.

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const SPENDS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const CREATES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const OVERWRITES = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;
const REPEATABLE_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

// --- Server setup ---

const server = new McpServer({
  name: "insumer",
  version: VERSION,
});

// ============================================================
// KEY DISCOVERY
// ============================================================

server.tool(
  "insumer_jwks",
  "Get InsumerAPI's public signing keys as a JWKS (JSON Web Key Set): an ECDSA P-256 key under its kids, followed by the ML-DSA-65 post-quantum key as RFC 9964 AKP entries. Signatures on attestation and trust responses verify against these keys. Match an entry by the kid (or pqKid) on the response, never by position; an unknown kid is unverifiable, not refuted. No authentication required.",
  {},
  { title: "Get public signing keys", ...READ_ONLY },
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
  "Generate a free-tier InsumerAPI key (insr_live_...). No credit card required. The user adds the key to their MCP config as INSUMER_API_KEY and restarts. One free key per email, with a per-IP daily limit. Free-tier allowance: https://insumermodel.com/pricing/",
  {
    email: z.string().email().max(254).describe("Email address for the API key"),
    appName: z.string().max(100).optional().describe("Name of your app or project (default: 'MCP Agent')"),
  },
  { title: "Create a free API key", ...CREATES },
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
  `Verify 1-10 on-chain conditions for a wallet and return a signed yes or no for each, never the balance. Condition types: token_balance, nft_ownership, eas_attestation (raw schemaId or a compliance template such as Coinbase Verifications or Gitcoin Passport), farcaster_id (IdRegistry on Optimism), evm_view_call (a single-address-argument view function returning bool), ratio_to_amount (balance >= multiple * amount), ratio_to_supply (balance / totalSupply >= minFraction, ERC-20 only), erc8004_agent (registered ERC-8004 agent on Base), and erc7710_delegation (a signed MetaMask-framework delegation from principal to agent is currently valid on Base; spend, target and call limits are reported as declaredLimits, not simulated). Chains: EVM chains plus Solana, XRPL, Bitcoin, Tron, Stellar and Sui; Bitcoin, Tron, Stellar and Sui support token_balance only. Responses are ECDSA-signed with a kid identifying the key and carry a post-quantum companion signature; each result includes evaluatedCondition, a SHA-256 conditionHash, and the block (EVM), ledger (XRPL, Stellar) or checkpoint (Sui) it was read at. proof: 'merkle' adds EIP-1186 storage proofs on supported EVM chains. Attestations with a delegation condition expire in 5 minutes instead of 30; a failed delegation result carries failReason. Costs 1 credit (2 with proof). ${COUNTS_NOTE}`,
  {
    wallet: EvmAddress.optional().describe("EVM wallet address (0x...)"),
    solanaWallet: SolanaAddress.optional().describe("Solana wallet address (base58)"),
    xrplWallet: XrplAddress.optional().describe("XRPL wallet address (r-address). For verifying XRP, trust line tokens (RLUSD, USDC), or NFTs on XRP Ledger."),
    bitcoinWallet: BitcoinAddress.optional().describe("Bitcoin address (P2PKH, P2SH, bech32, or Taproot). For verifying native BTC balance. Use chainId 'bitcoin' with contractAddress 'native'."),
    tronWallet: TronAddress.optional().describe("Tron wallet address (T-prefixed, base58). For verifying TRX or TRC20 tokens (USDT-TRC20). Use chainId 'tron'."),
    stellarWallet: StellarAddress.optional().describe("Stellar wallet address (G-prefixed). For verifying XLM or trustline assets (USDC, BENJI, etc.). Use chainId 'stellar' with the asset issuer's G-address as contractAddress and pass assetCode (e.g. 'USDC'). Soroban contract balances not visible — classic trustlines only."),
    suiWallet: SuiAddress.optional().describe("Sui wallet address (0x + 64 hex chars). For verifying SUI or other Sui coins (e.g. USDC). Use chainId 'sui' with the Sui coin type as contractAddress: '0x2::sui::SUI' for native SUI, or the full coin type address::module::Name for other coins. The string 'native' is not accepted on Sui."),
    proof: z.enum(["merkle"]).optional().describe("Set to 'merkle' for EIP-1186 Merkle storage proofs (2 credits). For token_balance on supported EVM chains (not ZKsync Era, Sei, Viction or XDC Network, and not on non-EVM chains); for erc7710_delegation, a storage proof of the revocation slot (subject 'delegation_revocation') on managers with an on-chain-verified layout."),
    declaredLimits: z.enum(["omit"]).optional().describe("Set to 'omit' to leave decoded caveat limits out of the signed results of erc7710_delegation conditions, so a forwarded attestation does not carry the principal's spending ceiling. met, delegationHash, and conditionHash are byte-identical either way."),
    format: z.enum(["jwt"]).optional().describe("Set to 'jwt' to include a Wallet Auth by InsumerAPI token (ES256-signed JWT) in the response, with its ML-DSA-65 sibling pqJwt beside it. The jwt is verifiable by any standard JWT library using JWKS at /.well-known/jwks.json."),
    conditions: z
      .array(
        z.object({
          type: z.enum(["token_balance", "nft_ownership", "eas_attestation", "farcaster_id", "evm_view_call", "ratio_to_amount", "ratio_to_supply", "erc8004_agent", "erc7710_delegation"]).describe("Condition type: token_balance, nft_ownership (EVM, Solana and XRPL), eas_attestation, farcaster_id (Farcaster IdRegistry on Optimism), evm_view_call (single-address-argument view function returning bool; RPC EVM chains only), ratio_to_amount (balance >= multiple * amount; RPC EVM chains only), ratio_to_supply (balance / totalSupply >= minFraction; RPC EVM chains, ERC-20 only), erc8004_agent (registered ERC-8004 agent on Base; agentId required), or erc7710_delegation (signed MetaMask-framework delegation validity on Base; delegationManager, expectedDelegator, and delegation required; max 3 per request)"),
          contractAddress: ContractRef.optional().describe("Token or NFT contract address (required for token_balance, nft_ownership, ratio_to_amount, and ratio_to_supply; ratio_to_supply requires an ERC-20 contract, no native). 'native' means the chain's native coin and is for token_balance and ratio_to_amount only. nft_ownership needs the NFT contract address (0x + 40 hex on EVM); 'native' with nft_ownership is rejected with a 400, so use token_balance for the native coin. On Sui, pass a coin type address::module::Name: native SUI is '0x2::sui::SUI', and 'native' is not accepted there."),
          chainId: ChainId.optional(),
          threshold: DecimalArg.optional().describe("Minimum balance for token_balance, as a decimal string in token/display units (e.g. \"100\", not base units). Numbers are accepted and coerced to a string. Must be > 0 when proof is merkle."),
          multiple: DecimalArg.optional().describe("For ratio_to_amount: collateralization multiple as a decimal string (e.g. \"10\" for 'hold >= 10x the amount'). Met iff balance >= multiple * amount. Numbers are accepted and coerced. Must be > 0."),
          amount: DecimalArg.optional().describe("For ratio_to_amount: per-request reference amount in token/display units as a decimal string (e.g. \"100\" for 100 USDC, not base units/wei). Numbers are accepted and coerced. Must be > 0."),
          minFraction: DecimalArg.optional().describe("For ratio_to_supply: required share of total supply, a decimal string in (0,1] (e.g. \"0.005\" for 0.5%). Met iff balance / totalSupply() >= minFraction. Numbers are accepted and coerced. For project/governance tokens, not stablecoins."),
          decimals: z.number().int().min(0).max(77).optional().describe("Optional. Leave it out: the token's own decimals are always read from the chain. If sent it is only a cross-check, and a value that differs from the token's own decimals is rejected with a 400."),
          label: z.string().max(100).optional().describe("Human-readable label"),
          schemaId: Bytes32.optional().describe("EAS schema ID (bytes32 hex). Required for eas_attestation unless template is provided."),
          attester: EvmAddress.optional().describe("Expected attester address (optional, for eas_attestation)"),
          indexer: EvmAddress.optional().describe("EAS indexer contract address (optional, for eas_attestation)"),
          template: z.enum(["coinbase_verified_account", "coinbase_verified_country", "coinbase_one", "gitcoin_passport_score", "gitcoin_passport_active"]).optional().describe("Compliance template name. Use instead of raw schemaId/attester/indexer for eas_attestation. Gitcoin Passport templates check Sybil resistance on Optimism."),
          currency: z.string().max(40).regex(/^[A-Za-z0-9]+$/).optional().describe("XRPL trust line currency code (e.g. 'RLUSD', 'USDC'). Required for XRPL trust line tokens, ignored for other chains."),
          assetCode: z.string().regex(/^[A-Za-z0-9]{1,12}$/).optional().describe("Stellar trustline asset code (e.g. 'USDC', 'BENJI'). Required for Stellar non-native (trustline) tokens. Use contractAddress 'native' for XLM. Ignored for other chains. Flows into conditionHash so different assets on the same issuer produce different hashes."),
          taxon: z.number().int().optional().describe("XRPL NFToken taxon filter (optional, for nft_ownership on XRPL only). Filters NFTs by issuer + taxon."),
          selector: z.string().max(100).regex(/^[A-Za-z_][A-Za-z0-9_]*\(address\)$/).optional().describe("Required for evm_view_call. Canonical signature of a view function returning bool, in the form 'functionName(address)' (e.g. 'hasAccess(address)'). Single-address-argument view functions only; the 4-byte selector is derived from this signature."),
          agentId: UintString.optional().describe("Required for erc8004_agent. The ERC-8004 agent ID as a uint256 decimal string — the caller must supply it (the deployed Identity Registry has no wallet-to-agentId reverse lookup). Met iff the attested wallet owns the agent NFT (ownerOf) or is the registry's signature-verified agentWallet binding. Registry 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 on Base; chainId 8453 only. Honest semantics: registration is permissionless minting — the signed statement implies no vetting, no reputation, no endorsement."),
          delegationManager: EvmAddress.optional().describe("Required for erc7710_delegation. DelegationManager contract the delegation was signed against — one of the recognized MetaMask Delegation Framework managers on Base (current default 0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3). chainId 8453 only."),
          expectedDelegator: EvmAddress.optional().describe("Required for erc7710_delegation. The principal address the caller asserts authorized this agent. The condition fails unless the delegation's declared delegator matches — without it a self-delegation would read as authority, so there is no structural-only mode."),
          delegation: z.object({
            delegator: EvmAddress.describe("Principal address that signed the delegation. Must equal expectedDelegator."),
            delegate: EvmAddress.describe("Agent wallet the delegation authorizes. Must equal the attested wallet."),
            authority: Bytes32.describe("Root authority only (0xffff…ffff, 32 bytes of 0xff). Delegation chains are unsupported."),
            caveats: z.array(z.object({
              enforcer: EvmAddress.describe("Caveat enforcer contract address"),
              terms: HexData(20000).describe("ABI-encoded caveat terms (hex)"),
            })).max(16).describe("Caveats the principal signed (max 16). Every enforcer must be recognized or the condition fails — no override."),
            salt: z.union([UintString, z.number().int().nonnegative()]).transform((v) => String(v)).describe("Delegation salt (decimal string; numbers coerced)"),
            signature: HexData(20000).describe("EIP-712 signature over the delegation (hex). EOA recovery, or ERC-1271 for smart-contract principals."),
          }).optional().describe("Required for erc7710_delegation. The signed ERC-7710 delegation to evaluate. Met iff ALL of: attested wallet is the delegate; declared delegator is expectedDelegator; EIP-712 signature verifies (EOA or ERC-1271); unrevoked at the anchored block; every caveat enforcer recognized; any time-window caveat currently satisfied. Recognized enforcers: timestamp (evaluated), erc20_transfer_amount, native_transfer_amount, allowed_targets, limited_calls (the last four are REPORTED as declaredLimits — redemption enforces them, the attestation does not simulate enforcement)."),
        })
      )
      .min(1)
      .max(10)
      .describe("1-10 on-chain conditions to verify"),
  },
  { title: "Verify wallet conditions (signed)", ...SPENDS },
  async (args) => {
    const result = await apiCall("POST", "/attest", args);
    return formatResult(result);
  }
);

server.tool(
  "insumer_compliance_templates",
  "List the compliance templates available for EAS attestation conditions. Each template carries pre-configured schema IDs, attester addresses, and decoder contracts for a KYC or identity provider (Coinbase Verifications on Base, Gitcoin Passport on Optimism), so a condition can name the template instead of raw EAS parameters. No authentication or credits required.",
  {},
  { title: "List compliance templates", ...READ_ONLY },
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
  `Generate a signed wallet trust fact profile for an EVM wallet: a curated set of presence checks organized into dimensions (stablecoins, governance, NFTs, staking, institutional stablecoins, tokenized treasuries, stablecoin deposits, wrapped bitcoin, names). Optional Solana, XRPL, Bitcoin and Tron wallets add their own dimensions; optional Stellar and Sui wallets let rows inside existing dimensions evaluate. Rows on a chain whose wallet is not supplied stay in the signed profile with evaluated: false. Every check is held or not held, never a balance. The signed conditionSetVersion names the check list that was run; log it, never reject on it. Returns per-dimension pass/fail counts and an overall summary: no score, no opinion. Designed for AI agent-to-agent trust decisions. Costs 3 credits (6 with proof: 'merkle'). ${COUNTS_NOTE}`,
  {
    wallet: EvmAddress.describe("EVM wallet address (0x...) to profile"),
    solanaWallet: SolanaAddress.optional().describe("Solana wallet address (base58). If provided, adds the Solana dimension and lets the institutional rows on Solana evaluate."),
    xrplWallet: XrplAddress.optional().describe("XRPL wallet address (r-address). If provided, adds the XRPL dimension and lets the institutional row on XRPL evaluate."),
    bitcoinWallet: BitcoinAddress.optional().describe("Bitcoin address. If provided, adds the Bitcoin dimension (native BTC presence)."),
    tronWallet: TronAddress.optional().describe("Tron wallet address (T-prefixed). If provided, adds the Tron dimension."),
    stellarWallet: StellarAddress.optional().describe("Stellar wallet address (G-prefixed). If provided, lets the institutional rows on Stellar evaluate (classic trustlines). Adds no dimension."),
    suiWallet: SuiAddress.optional().describe("Sui wallet address (0x + 64 hex). If provided, lets the rows on Sui evaluate. Adds no dimension."),
    proof: z.enum(["merkle"]).optional().describe("Set to 'merkle' for EIP-1186 Merkle storage proofs on EVM token checks (6 credits). Rows whose balance is computed rather than stored (Aave aTokens, BUIDL) and NFT/non-EVM rows are declined with a reason; the premium is refunded whenever no proof is delivered."),
  },
  { title: "Wallet trust profile (signed)", ...SPENDS },
  async (args) => {
    const result = await apiCall("POST", "/trust", args);
    return formatResult(result);
  }
);

server.tool(
  "insumer_batch_wallet_trust",
  "Generate wallet trust fact profiles for up to 10 wallets in a single request. Shared block fetches make this faster than sequential calls. Each wallet gets an independently signed profile with its own TRST-XXXXX ID. Supports partial success: failed wallets get error entries while successful ones return full profiles. Costs 3 credits per successful wallet (6 with proof: 'merkle'); credits are charged only for successful profiles.",
  {
    wallets: z
      .array(
        z.object({
          wallet: EvmAddress.describe("EVM wallet address (0x...)"),
          solanaWallet: SolanaAddress.optional().describe("Solana wallet address (base58). Adds the Solana dimension."),
          xrplWallet: XrplAddress.optional().describe("XRPL wallet address (r-address). Adds the XRPL dimension."),
          bitcoinWallet: BitcoinAddress.optional().describe("Bitcoin address. Adds the Bitcoin dimension."),
          tronWallet: TronAddress.optional().describe("Tron wallet address (T-prefixed). Adds the Tron dimension."),
          stellarWallet: StellarAddress.optional().describe("Stellar wallet address (G-prefixed). Lets the rows on Stellar evaluate; adds no dimension."),
          suiWallet: SuiAddress.optional().describe("Sui wallet address (0x + 64 hex). Lets the rows on Sui evaluate; adds no dimension."),
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
  { title: "Batch wallet trust profiles (signed)", ...SPENDS },
  async (args) => {
    const result = await apiCall("POST", "/trust/batch", args);
    return formatResult(result);
  }
);

server.tool(
  "insumer_verify",
  "Create a signed discount code (INSR-XXXXX, 30-minute expiry) for a wallet at a merchant. Returns tier and discount percentage, never raw balance amounts. Consumes 1 merchant credit. If the merchant has Stripe Connect, a coupon is auto-created.",
  {
    merchantId: MerchantId.describe("Merchant ID"),
    ...WalletFields,
  },
  { title: "Create a discount code", ...SPENDS },
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
    token: ShortText(32).optional().describe("Filter by accepted token symbol, e.g. 'UNI'"),
    verified: z.enum(["true", "false"]).optional().describe("Filter by domain verification status"),
    limit: z.number().int().min(1).max(200).optional().describe("Results per page (default 50, max 200)"),
    offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)"),
  },
  { title: "List merchants", ...READ_ONLY },
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
    id: MerchantId.describe("Merchant ID"),
  },
  { title: "Get a merchant profile", ...READ_ONLY },
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
    symbol: ShortText(32).optional().describe("Filter by token symbol"),
    type: z.enum(["token", "nft"]).optional().describe("Filter by asset type"),
  },
  { title: "List registered tokens", ...READ_ONLY },
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
  "Calculate discount for a wallet at a merchant. Checks on-chain balances and returns tier and discount percentage per token, never raw balance amounts. Free: does not consume credits.",
  {
    merchant: MerchantId.describe("Merchant ID"),
    ...WalletFields,
  },
  { title: "Check a discount (free)", ...READ_ONLY },
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
  "Check verification credit balance, tier, and daily rate limit for the current API key.",
  {},
  { title: "Check credit balance", ...READ_ONLY },
  async () => {
    const result = await apiCall("GET", "/credits");
    return formatResult(result);
  }
);

server.tool(
  "insumer_buy_key",
  `Register a new API key against a USDC, USDT, BTC, or USDT-TRC20 payment the caller has already sent (no auth required, no email). This tool does not move funds: it submits the transaction hash. Receiving addresses: EVM 0xAd982CB19aCCa2923Df8F687C0614a7700255a23, Solana 6a1mLjefhvSJX1sEX8PTnionbE9DqoYjU6F6bNkT4Ydr, Tron TC5yvwkAMakkXtUxYiu2Yn1xbBcwYuD6cn, Bitcoin bc1qg7qnerdhlmdn899zemtez5tcx2a2snc0dt9dt0 (1 confirmation required). USDC/USDT auto-detected from the transaction; BTC converted to USD at market rate. One key per wallet; existing keys are topped up with a credit purchase instead. Non-refundable. ${PRICING_NOTE}`,
  {
    txHash: TxHash.describe("Transaction hash proving payment"),
    chainId: UsdcChainIdWithBitcoin,
    amount: z.number().min(5).optional().describe("Stablecoin amount sent (minimum 5). Not required for BTC — USD value derived from on-chain amount at market rate."),
    appName: z.string().max(100).describe("Name for the API key (e.g. your agent or app name)"),
  },
  { title: "Register a paid API key", ...CREATES },
  async (args) => {
    const result = await publicApiCall("POST", "/keys/buy", args);
    return formatResult(result);
  }
);

server.tool(
  "insumer_buy_credits",
  `Add verification credits to the current API key against a USDC, USDT, BTC, or USDT-TRC20 payment the caller has already sent. This tool does not move funds: it submits the transaction hash. USDC/USDT on EVM and Solana (auto-detected), USDT-TRC20 on Tron, BTC on Bitcoin (converted at market rate, 1 confirmation required). Crypto sent on unsupported chains cannot be recovered. Non-refundable. The first purchase registers the sender wallet to the API key; later purchases must come from the same sender, and updateWallet: true replaces the registered wallet. ${PRICING_NOTE}`,
  {
    txHash: TxHash.describe("Transaction hash proving payment"),
    chainId: UsdcChainIdWithBitcoin,
    amount: z.number().min(5).optional().describe("Stablecoin amount sent (minimum 5). Not required for BTC."),
    updateWallet: z.boolean().optional().default(false).describe("Set true to replace the registered sender wallet with this transaction's sender"),
  },
  { title: "Add credits from a payment", ...OVERWRITES, idempotentHint: false },
  async (args) => {
    const result = await apiCall("POST", "/credits/buy", args);
    return formatResult(result);
  }
);

server.tool(
  "insumer_confirm_payment",
  "Confirm the stablecoin payment for an INSR discount code. The server verifies the on-chain transaction receipt.",
  {
    code: DiscountCode.describe("Discount code (e.g. INSR-A7K3M)"),
    txHash: TxHash.describe("On-chain transaction hash or Solana signature"),
    chainId: UsdcChainId,
    amount: z.union([DecimalString, z.number()]).describe("Stablecoin amount sent"),
  },
  { title: "Confirm a discount payment", ...REPEATABLE_WRITE },
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
  "Create a new merchant, owned by the API key that creates it, with an initial allowance of free verification credits. Limited number of merchants per API key.",
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
  { title: "Create a merchant", ...CREATES },
  async (args) => {
    const result = await apiCall("POST", "/merchants", args);
    return formatResult(result);
  }
);

server.tool(
  "insumer_merchant_status",
  "Get full private merchant details: credits, token configs, NFT collections, directory status, verification status, payment settings. Owner only.",
  {
    id: MerchantId.describe("Merchant ID"),
  },
  { title: "Get merchant status (owner)", ...READ_ONLY },
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
  "Configure merchant token discount tiers. Set own token and/or partner tokens. Replaces the existing token configuration. Max 8 tokens total. Owner only.",
  {
    id: MerchantId.describe("Merchant ID"),
    ownToken: TokenConfigSchema.nullable()
      .optional()
      .describe("Merchant's own token configuration, or null to remove"),
    partnerTokens: z
      .array(TokenConfigSchema)
      .max(8)
      .optional()
      .describe("Partner token configurations"),
  },
  { title: "Configure merchant tokens (replaces)", ...OVERWRITES },
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
  "Configure NFT collections that grant discounts at the merchant. Replaces the existing NFT configuration. Max 4 collections. Owner only.",
  {
    id: MerchantId.describe("Merchant ID"),
    nftCollections: z
      .array(NftCollectionSchema)
      .min(0)
      .max(4)
      .describe("NFT collection configurations (0-4)"),
  },
  { title: "Configure merchant NFTs (replaces)", ...OVERWRITES },
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
  "Update merchant settings: discount stacking mode, cap, and stablecoin payment configuration. All fields optional; supplied fields replace their current values. Owner only.",
  {
    id: MerchantId.describe("Merchant ID"),
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
        evmAddress: EvmAddress.optional().describe("EVM wallet for USDC (0x...)"),
        solanaAddress: SolanaAddress.optional().describe("Solana wallet for USDC"),
        preferredChainId: UsdcChainId.optional().describe("Preferred USDC chain"),
      })
      .nullable()
      .optional()
      .describe("USDC payment settings, or null to disable"),
  },
  { title: "Update merchant settings", ...OVERWRITES },
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
  "Publish or refresh the merchant's listing in the public directory from its current tokens and settings. Owner only.",
  {
    id: MerchantId.describe("Merchant ID"),
  },
  { title: "Publish directory listing", ...REPEATABLE_WRITE },
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
  `Add merchant verification credits against a USDC, USDT, BTC, or USDT-TRC20 payment the caller has already sent. This tool does not move funds: it submits the transaction hash. USDC/USDT on EVM and Solana (auto-detected), USDT-TRC20 on Tron, BTC on Bitcoin (converted at market rate, 1 confirmation required). Non-refundable. Owner only. The first purchase registers the sender wallet to the API key; updateWallet: true replaces it. ${PRICING_NOTE}`,
  {
    id: MerchantId.describe("Merchant ID"),
    txHash: TxHash.describe("Transaction hash proving payment"),
    chainId: UsdcChainIdWithBitcoin,
    amount: z.number().min(5).optional().describe("Stablecoin amount sent (minimum 5). Not required for BTC."),
    updateWallet: z.boolean().optional().default(false).describe("Set true to replace the registered sender wallet"),
  },
  { title: "Add merchant credits from a payment", ...OVERWRITES, idempotentHint: false },
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
  "Request a domain verification token for a merchant. Returns the token and three ways to place it: DNS TXT record, HTML meta tag, or file upload. Verified merchants get a trust badge in the public directory. Owner only.",
  {
    id: MerchantId.describe("Merchant ID"),
    domain: Domain.describe("Domain to verify (e.g. 'example.com')"),
  },
  { title: "Request domain verification", ...CREATES },
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
  "Check a merchant's previously requested domain verification token. The server looks for it as a DNS TXT record, HTML meta tag, or uploaded file, and marks the domain verified when found. Rate limited to 5 attempts per hour. Owner only.",
  {
    id: MerchantId.describe("Merchant ID"),
  },
  { title: "Verify domain ownership", ...REPEATABLE_WRITE },
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

const LineItems = z
  .array(
    z.object({
      path: z.string().max(200).describe("JSONPath reference to the line item, e.g. '$.line_items[0]'"),
      amount: z.number().int().describe("Item price in cents"),
    })
  )
  .max(100)
  .optional()
  .describe("Optional line items for per-item cent-amount allocations");

server.tool(
  "insumer_acp_discount",
  "Check token-holder discount eligibility in OpenAI/Stripe Agentic Commerce Protocol (ACP) format. Returns coupon objects, applied/rejected arrays, and per-item allocations compatible with ACP checkout flows. The on-chain check is the same one behind INSR discount codes, wrapped in ACP format. Consumes 1 merchant credit.",
  {
    merchantId: MerchantId.describe("Merchant ID"),
    ...WalletFields,
    items: LineItems,
  },
  { title: "Discount in ACP format", ...SPENDS },
  async (args) => {
    const result = await apiCall("POST", "/acp/discount", args);
    return formatResult(result);
  }
);

server.tool(
  "insumer_ucp_discount",
  "Check token-holder discount eligibility in Google Universal Commerce Protocol (UCP) format. Returns title, extension field, and applied array compatible with UCP checkout flows. The on-chain check is the same one behind INSR discount codes, wrapped in UCP format. Consumes 1 merchant credit.",
  {
    merchantId: MerchantId.describe("Merchant ID"),
    ...WalletFields,
    items: LineItems,
  },
  { title: "Discount in UCP format", ...SPENDS },
  async (args) => {
    const result = await apiCall("POST", "/ucp/discount", args);
    return formatResult(result);
  }
);

server.tool(
  "insumer_validate_code",
  "Validate an INSR-XXXXX discount code. For merchant backends during ACP/UCP checkout to confirm code validity, discount percent, and expiry. Returns valid/invalid status with reason. No authentication required, no credits consumed. Does not expose wallet or token data.",
  {
    code: DiscountCode.describe("Discount code in INSR-XXXXX format"),
  },
  { title: "Validate a discount code", ...READ_ONLY },
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
