import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
import { summarizeBatchTrust } from "./batch-summary.js";

export const VERSION = "1.20.3";
const API_BASE = "https://api.insumermodel.com/v1";
const KEYGEN_URL = "https://api.insumermodel.com/v1/keys/create";

type ApiResult = { ok: boolean; data?: unknown; error?: unknown; meta?: unknown };

/**
 * Options for one server instance. The stdio binary fills these from the
 * environment; a hosted deployment passes them in directly.
 */
export interface InsumerServerOptions {
  /** InsumerAPI key (insr_live_...). Metered calls spend its credits. */
  apiKey?: string;
  /** Base wallet private key for x402 pay-per-call when no API key is set. */
  paymentKey?: string;
  /** Per-call USDC cap for pay-per-call (decimal string). Default $3.00. */
  maxPaymentUsdc?: string;
  /**
   * Tool names to register. Omitted means every tool. A hosted deployment on a
   * shared key registers only the tools that make sense without a caller
   * identity (see HOSTED_TOOLS).
   */
  tools?: readonly string[];
  /**
   * Runs before every call that spends credits (attest, trust, batch trust).
   * Return a message to refuse the call (it is returned to the model as an
   * error result and nothing is sent to the API), or null to allow it.
   */
  beforeMeteredCall?: (path: string) => Promise<string | null> | string | null;
  /**
   * Strip the key's own figures (meta.creditsRemaining) from responses. A
   * hosted deployment on a shared key sets this so callers learn nothing
   * about the key behind the endpoint. The signed payload is untouched.
   */
  hideKeyMeta?: boolean;
}

/**
 * Tools a hosted, anonymous deployment serves on a shared key. Everything here
 * either needs no key or spends only the shared key's credits on a read of
 * public chain state. Left out: key and credit management (there is no caller
 * to own them), merchant management (owner-only on the key), discount creation
 * (charges the store owner's key), and the credit balance (the shared key's own).
 */
export const HOSTED_TOOLS = [
  "insumer_jwks",
  "insumer_attest",
  "insumer_compliance_templates",
  "insumer_wallet_trust",
  "insumer_batch_wallet_trust",
  "insumer_list_merchants",
  "insumer_get_merchant",
  "insumer_list_tokens",
  "insumer_check_discount",
  "insumer_validate_code",
] as const;

async function publicApiCall(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<ApiResult> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json() as Promise<ApiResult>;
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

// The output schema every tool declares. It describes the response envelope
// rather than each endpoint's payload, so it stays true as endpoints add fields.
const RESULT_SCHEMA = z.object({
  ok: z.boolean().optional().describe("true when the API call succeeded"),
  data: z.unknown().optional().describe("The endpoint's payload: a signed attestation, trust profile, discount, merchant or token records"),
  meta: z.unknown().optional().describe("Response metadata such as version and timestamp"),
  error: z.unknown().optional().describe("Error details when ok is false"),
  keys: z.array(z.unknown()).optional().describe("JWKS entries (insumer_jwks)"),
  items: z.array(z.unknown()).optional().describe("The result when the endpoint returns a JSON array"),
  message: z.unknown().optional().describe("A plain-text result (insumer_setup), or a message from the API"),
}).passthrough();

// Successful results carry their JSON as structuredContent; the text content is
// left exactly as it was. Error results are passed through untouched, and so is
// a result whose handler already set structuredContent (the batch trust summary).
function withStructuredContent(result: ToolResult): ToolResult {
  if (result.isError || result.structuredContent) return result;
  const text = result.content[0]?.text ?? "";
  let structured: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) structured = { items: parsed };
    else if (parsed !== null && typeof parsed === "object") structured = parsed as Record<string, unknown>;
    else structured = { message: text };
  } catch {
    structured = { message: text };
  }
  return { ...result, structuredContent: structured };
}

function formatResult(result: ApiResult) {
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
// A condition's contract reference also takes a Sui coin type with type parameters,
// e.g. 0x2::coin::Coin<0x2::sui::SUI>: angle brackets, commas and one space after a comma.
const SuiGenericCoinType = z
  .string()
  .max(600)
  .regex(/^0x[0-9a-fA-F]{1,64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*<[A-Za-z0-9:_<>, ]+>$/, "Sui coin type with type parameters");
const ConditionContractRef = z.union([ContractRef, SuiGenericCoinType]);
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

// Payment confirmation for discount codes: USDC on the seven EVM payment
// chains or Solana. Bitcoin and Tron are not accepted there.
const ConfirmPaymentChainId = z
  .union([
    z.enum(["1", "8453", "137", "42161", "10", "56", "43114"]).transform(Number),
    z.number().int().refine(
      (n) => [1, 8453, 137, 42161, 10, 56, 43114].includes(n),
      "Must be a supported payment chain"
    ),
    z.literal("solana"),
  ])
  .describe("Chain where the USDC was sent: EVM chain ID (1, 8453, 137, 42161, 10, 56, 43114) or 'solana'. Bitcoin and Tron are not accepted here.");

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
  discount: z.number().int().min(1).max(50).describe("Discount percentage: a whole number from 1 to 50, no decimals"),
});

const TokenConfigSchema = z.object({
  symbol: z.string().max(10).describe("Token symbol, e.g. 'UNI'"),
  chainId: OnboardingChainId,
  contractAddress: ContractRef.describe("Token contract address. For XRPL: use r-address issuer for trust line tokens, or 'native' for XRP."),
  decimals: z.number().int().min(0).max(18).describe("Token decimals (0-18). Required: the merchant registry stores it with each token and rejects a config without it. 6 for USDC, 18 for most ERC-20s."),
  currency: z.string().min(1).max(40).regex(/^[\x20-\x7E]+$/).optional().describe("XRPL trust line currency code: a 3-character code (e.g. 'USD'), a token name of 1 to 20 printable ASCII characters (e.g. 'RLUSD'), or a 40-character hex code. Case-sensitive: send it exactly as the issuer created it. 'XRP' is the native coin and is not accepted here: use contractAddress 'native'. Required for XRPL trust line tokens."),
  name: z.string().max(100).optional().describe("Display name of the token, shown in the public directory (max 100 characters). Optional."),
  logo: z.string().max(500).optional().describe("Logo URL for the token, shown in the public directory (max 500 characters). Optional."),
  tiers: z.array(TierSchema).min(1).max(4).describe("1-4 discount tiers"),
  alsoOn: z
    .array(
      z.object({
        chainId: z.union([z.number().int().positive(), z.literal("solana")]).describe("EVM chain ID, or 'solana'"),
        contractAddress: z.string().min(1).max(64).describe("The same token's contract (EVM) or mint (Solana) on that network; not 'native'"),
      })
    )
    .max(9)
    .optional()
    .describe(
      "Optional: the same token on other networks, up to 9 (EVM chains and Solana; not the XRP Ledger, not a native coin). " +
      "The store decides which deployments count as the same token. Each network's balance is read in that token's own decimals there, " +
      "the balances are added exactly, and the tier is awarded once. A read that fails on any listed network refuses the whole check (rpc_failure), never a partial total. " +
      "When re-saving, carry each token's alsoOn through, or its other networks are removed."
    ),
});

// The merchant's own token also carries an on/off switch.
const OwnTokenConfigSchema = TokenConfigSchema.extend({
  enabled: z.boolean().optional().describe("true or false, never a string. false switches the own token off; leave it out or send true to keep it on."),
});

const NftCollectionSchema = z.object({
  name: z.string().max(50).describe("NFT collection name"),
  contractAddress: ContractRef.describe("NFT contract address. For XRPL: use r-address of the NFT issuer."),
  taxon: z.number().int().min(0).max(4294967295).optional().describe("XRPL NFT taxon for filtering by collection: an integer from 0 to 4294967295. Optional, XRPL only."),
  chainId: OnboardingChainId,
  benefitType: z.enum(["discount", "recognition"]).optional().describe("'discount' (the default) grants the discount below. 'recognition' means holders are recognized and no discount is granted."),
  discount: z.number().int().min(1).max(50).optional().describe("Discount percentage: a whole number from 1 to 50, no decimals. Required unless benefitType is 'recognition'."),
  enabled: z.boolean().optional().describe("true or false. false keeps the collection in the configuration but switched off. Leave it out for an enabled collection. When re-saving an existing configuration, carry each collection's enabled value through, or a collection that was switched off is switched back on."),
});

// Optional wallet fields shared by the verification and discount tools. The
// merchant endpoints read these three and no others.
const WalletFields = {
  wallet: EvmAddress.optional().describe("EVM wallet address (0x...)"),
  solanaWallet: SolanaAddress.optional().describe("Solana wallet address (base58)"),
  xrplWallet: XrplAddress.optional().describe("XRPL wallet address (r-address)"),
};

// Optional proof that the caller controls the EVM wallet, on the discount-issuing tools.
const WalletProof = z
  .object({
    message: z.string().max(4096).describe("The EIP-4361 message, exactly as signed"),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/, "0x hex signature").max(2000).describe("The wallet's personal_sign (EIP-191) signature over the message"),
  })
  .optional()
  .describe(
    "Optional proof that you control 'wallet' (EVM only; send it without solanaWallet or xrplWallet). " +
    "Sign this EIP-4361 message with the wallet, within 5 minutes, with a nonce you never reused:\n" +
    "api.insumermodel.com wants you to sign in with your Ethereum account:\n<wallet>\n\nProve wallet for a discount.\n\n" +
    "URI: https://api.insumermodel.com/v1/merchants/<merchantId>\nVersion: 1\nChain ID: 1\nNonce: <8+ random letters or digits>\nIssued At: <ISO 8601 time now>\n" +
    "A proven wallet gets the full discount its holdings earn (under the store's tiers and cap), without the daily limit for unproven wallets. Without it, the store's terms for unproven wallets apply (see walletTerms on the merchant). " +
    "A proof that fails returns 401 and uses no credit. Smart-contract wallets are not accepted yet."
  );

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

/**
 * Build a configured InsumerAPI MCP server. The caller connects it to a
 * transport: stdio for a local install, streamable HTTP for a hosted one.
 * Returns the server and any configuration warnings (the stdio binary prints
 * them to stderr; a hosted deployment logs them).
 */
export function createInsumerServer(options: InsumerServerOptions = {}): { server: McpServer; warnings: string[] } {
  const warnings: string[] = [];
  const apiKey = options.apiKey ?? "";
  // Pay-per-call: with no API key but a funded Base wallet key, metered calls are
  // paid inline via x402 (EIP-3009 USDC on Base): no signup, no credits. Use a
  // THROWAWAY wallet funded with a small amount of USDC. Each quote is checked
  // before signing (see payment-guard.ts): InsumerAPI's own receiving address,
  // USDC on Base, and no more than the cap per call.
  const paymentKey = (options.paymentKey ?? "").trim();
  const paymentAccount = /^0x[0-9a-fA-F]{64}$/.test(paymentKey)
    ? privateKeyToAccount(paymentKey as `0x${string}`)
    : null;
  if (!apiKey && !paymentAccount) {
    warnings.push("Neither INSUMER_API_KEY nor INSUMER_PAYMENT_KEY set. Use insumer_setup for a free API key, or set INSUMER_PAYMENT_KEY to a funded Base wallet to pay per call via x402.");
  }

  // The payment cap. A malformed value is never replaced by the default: payments
  // are refused until it is fixed.
  let paymentCapUnits: bigint | null = null;
  let paymentCapError: string | null = null;
  try {
    paymentCapUnits = parseUsdcCap(options.maxPaymentUsdc ?? DEFAULT_MAX_PAYMENT_USDC);
    if (paymentAccount && paymentCapUnits < MIN_CALL_PRICE_UNITS) {
      warnings.push("INSUMER_MAX_PAYMENT_USDC is below the cheapest paid call ($0.05), so every paid call will be refused.");
    }
  } catch (err) {
    paymentCapError = (err as Error).message;
    if (paymentAccount) warnings.push(`${paymentCapError} Pay-per-call is disabled until it is fixed.`);
  }

  // --- Shared API helper ---

  async function apiCall(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<ApiResult> {
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
    const result = (await res.json()) as ApiResult;
    if (options.hideKeyMeta && result.meta && typeof result.meta === "object") {
      delete (result.meta as Record<string, unknown>).creditsRemaining;
    }
    return result;
  }

  // x402 pay-per-call: request the priced 402, check the quote, sign an EIP-3009
  // USDC transfer for exactly the quoted amount, retry with the payment header.
  // The facilitator settles on Base; the wallet needs USDC but no ETH (gasless).
  async function x402Call(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<ApiResult> {
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
      return quoteRes.json() as Promise<ApiResult>;
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
    return paidRes.json() as Promise<ApiResult>;
  }

  // A metered call asks the deployment first. Nothing is sent when it refuses.
  async function gate(path: string) {
    if (!options.beforeMeteredCall) return null;
    const refusal = await options.beforeMeteredCall(path);
    if (!refusal) return null;
    return { content: [{ type: "text" as const, text: refusal }], isError: true };
  }

  // --- Server setup ---

  const server = new McpServer({
    name: "insumer",
    version: VERSION,
  });

  // Register a tool unless the deployment left it out. Every tool declares the
  // shared output schema, and every successful result carries its JSON as
  // structuredContent beside the unchanged text content.
  const allow = options.tools ? new Set(options.tools) : null;
  const tool = (
    name: string,
    description: string,
    inputSchema: z.ZodRawShape,
    annotations: { title: string } & Record<string, unknown>,
    handler: (args: any) => Promise<ToolResult>
  ) => {
    if (allow && !allow.has(name)) return undefined;
    return server.registerTool(
      name,
      { title: annotations.title, description, inputSchema, outputSchema: RESULT_SCHEMA, annotations },
      async (args: any) => withStructuredContent(await handler(args))
    );
  };

  // ============================================================
  // ON-CHAIN VERIFICATION
  // ============================================================

  tool(
    "insumer_attest",
    `Verify 1-10 on-chain conditions for a wallet and return a signed yes or no for each, never the balance. Condition types: token_balance, nft_ownership, eas_attestation (raw schemaId or a compliance template such as Coinbase Verifications or Gitcoin Passport), farcaster_id (IdRegistry on Optimism), evm_view_call (a single-address-argument view function returning bool), ratio_to_amount (balance >= multiple * amount), ratio_to_supply (balance / totalSupply >= minFraction, ERC-20 only), erc8004_agent (registered ERC-8004 agent on Base), erc7710_delegation (a signed MetaMask-framework delegation from principal to agent is currently valid on Base; spend, target and call limits are reported as declaredLimits, not simulated), and account_code (the code state of the wallet address itself at the anchored block on an EVM chain: expect 'none' for a plain key account, 'eip7702' for an EIP-7702 delegation designator, optionally to a given delegate, or 'contract' for any other code; the answer is met or not met, and the code and the delegation target are never returned). Chains: EVM chains plus Solana, XRPL, Bitcoin, Tron, Stellar and Sui; Bitcoin, Tron, Stellar and Sui support token_balance only. Responses are ECDSA-signed with a kid identifying the key and carry a post-quantum companion signature; each result includes evaluatedCondition, a SHA-256 conditionHash, and the block (EVM), ledger (XRPL, Stellar) or checkpoint (Sui) it was read at. proof: 'merkle' adds EIP-1186 proofs on supported EVM chains: a balance-slot storage proof for token_balance and ratio_to_amount (an account proof, subject account_balance, for the native coin), an account proof (subject account_code) for account_code, and a revocation-slot proof (subject delegation_revocation) for erc7710_delegation. Attestations with a delegation condition expire in 5 minutes instead of 30; a failed delegation result carries failReason. Costs 1 credit (2 with proof). An rpc_failure error (503) means a read did not complete and nothing was signed: retry, and never treat it as a no. ${COUNTS_NOTE}`,
    {
      wallet: EvmAddress.optional().describe("EVM wallet address (0x...)"),
      solanaWallet: SolanaAddress.optional().describe("Solana wallet address (base58)"),
      xrplWallet: XrplAddress.optional().describe("XRPL wallet address (r-address). For verifying XRP, trust line tokens (RLUSD, USDC), or NFTs on XRP Ledger."),
      bitcoinWallet: BitcoinAddress.optional().describe("Bitcoin address (P2PKH, P2SH, bech32, or Taproot). For verifying native BTC balance. Use chainId 'bitcoin' with contractAddress 'native'."),
      tronWallet: TronAddress.optional().describe("Tron wallet address (T-prefixed, base58). For verifying TRX or TRC20 tokens (USDT-TRC20). Use chainId 'tron'."),
      stellarWallet: StellarAddress.optional().describe("Stellar wallet address (G-prefixed). For verifying XLM or trustline assets (USDC, BENJI, etc.). Use chainId 'stellar' with the asset issuer's G-address as contractAddress and pass assetCode (e.g. 'USDC'). Soroban contract balances not visible; classic trustlines only."),
      suiWallet: SuiAddress.optional().describe("Sui wallet address (0x + 64 hex chars). For verifying SUI or other Sui coins (e.g. USDC). Use chainId 'sui' with the Sui coin type as contractAddress: '0x2::sui::SUI' for native SUI, or the full coin type address::module::Name for other coins. The string 'native' is not accepted on Sui."),
      proof: z.enum(["merkle"]).optional().describe("Set to 'merkle' for EIP-1186 Merkle proofs (2 credits, refunded to 1 when no proof is delivered). For token_balance or ratio_to_amount against an ERC-20, a storage proof of the balance slot (no subject field); for the same conditions with contractAddress 'native', an account proof whose balance field is the value evaluated (subject 'account_balance'); for account_code, an account proof whose codeHash is the value evaluated (subject 'account_code'); for erc7710_delegation, a storage proof of the revocation slot (subject 'delegation_revocation') on managers with an on-chain-verified layout. Supported EVM chains only (not ZKsync Era, Sei, Viction or XDC Network, and not on non-EVM chains)."),
      declaredLimits: z.enum(["omit"]).optional().describe("Set to 'omit' to leave decoded caveat limits out of the signed results of erc7710_delegation conditions, so a forwarded attestation does not carry the principal's spending ceiling. met, delegationHash, and conditionHash are byte-identical either way."),
      format: z.enum(["jwt"]).optional().describe("Set to 'jwt' to include a Wallet Auth by InsumerAPI token (ES256-signed JWT) in the response, with its ML-DSA-65 sibling pqJwt beside it. The jwt is verifiable by any standard JWT library using JWKS at /.well-known/jwks.json."),
      conditions: z
        .array(
          z.object({
            type: z.enum(["token_balance", "nft_ownership", "eas_attestation", "farcaster_id", "evm_view_call", "ratio_to_amount", "ratio_to_supply", "erc8004_agent", "erc7710_delegation", "account_code"]).describe("Condition type: token_balance, nft_ownership (EVM, Solana and XRPL), eas_attestation, farcaster_id (Farcaster IdRegistry on Optimism), evm_view_call (single-address-argument view function returning bool; EVM chains only), ratio_to_amount (balance >= multiple * amount; EVM chains only), ratio_to_supply (balance / totalSupply >= minFraction; EVM chains, ERC-20 only), erc8004_agent (registered ERC-8004 agent on Base; agentId required), erc7710_delegation (signed MetaMask-framework delegation validity on Base; delegationManager, expectedDelegator, and delegation required; max 3 per request), or account_code (the code state of the wallet address itself on an EVM chain; expect required, delegate optional with expect 'eip7702'; no contractAddress)"),
            contractAddress: ConditionContractRef.optional().describe("Token or NFT contract address (required for token_balance, nft_ownership, ratio_to_amount, and ratio_to_supply; ratio_to_supply requires an ERC-20 contract, no native). 'native' means the chain's native coin and is for token_balance and ratio_to_amount only. nft_ownership needs the NFT contract address (0x + 40 hex on EVM); 'native' with nft_ownership is rejected with a 400, so use token_balance for the native coin. On Sui, pass a coin type address::module::Name: native SUI is '0x2::sui::SUI', and 'native' is not accepted there. A coin type may carry type parameters in angle brackets."),
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
            currency: z.string().min(1).max(40).regex(/^[\x20-\x7E]+$/).optional().describe("XRPL trust line currency code (e.g. 'RLUSD'). Case-sensitive: enter it exactly as the issuer created it. Required for XRPL trust line tokens, ignored for other chains."),
            assetCode: z.string().regex(/^[A-Za-z0-9]{1,12}$/).optional().describe("Stellar trustline asset code (e.g. 'USDC', 'BENJI'). Required for Stellar non-native (trustline) tokens. Use contractAddress 'native' for XLM. Ignored for other chains. Flows into conditionHash so different assets on the same issuer produce different hashes."),
            taxon: z.number().int().min(0).max(4294967295).optional().describe("XRPL NFToken taxon filter: an integer from 0 to 4294967295 (optional, for nft_ownership on XRPL only). Filters NFTs by issuer + taxon."),
            selector: z.string().max(100).regex(/^[A-Za-z_][A-Za-z0-9_]*\(address\)$/).optional().describe("Required for evm_view_call. Canonical signature of a view function returning bool, in the form 'functionName(address)' (e.g. 'hasAccess(address)'). Single-address-argument view functions only; the 4-byte selector is derived from this signature."),
            agentId: UintString.optional().describe("Required for erc8004_agent. The ERC-8004 agent ID as a uint256 decimal string; the caller must supply it (the deployed Identity Registry has no wallet-to-agentId reverse lookup). Met iff the attested wallet owns the agent NFT (ownerOf) or is the registry's signature-verified agentWallet binding. Registry 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 on Base; chainId 8453 only. Honest semantics: registration is permissionless minting, so the signed statement implies no vetting, no reputation, no endorsement."),
            expect: z.enum(["none", "eip7702", "contract"]).optional().describe("Required for account_code: the code state the wallet address itself must be in at the anchored block. 'none' is no code (a plain key account); 'eip7702' is the EIP-7702 delegation designator (a key that has delegated execution to a contract); 'contract' is any other code (a smart-contract wallet, a protocol, a token). The three states are exclusive on a chain. EVM chains only; a non-EVM chainId is rejected with a 400. The result is met or not met, like every type: the code and the delegation target are never returned, in any format or mode. The signed evaluatedCondition is {type, chainId, expect, operator: 'code_state'}. With proof 'merkle', the proof is an EIP-1186 account proof (subject 'account_code') whose codeHash is the proven value."),
            delegate: EvmAddress.optional().describe("For account_code with expect 'eip7702' only (a 400 with any other expect): an EVM address; met iff the wallet's EIP-7702 designator points at it. Echoed in lowercase inside the signed evaluatedCondition as the caller's input; the actual delegation target is never returned."),
            delegationManager: EvmAddress.optional().describe("Required for erc7710_delegation. DelegationManager contract the delegation was signed against: one of the recognized MetaMask Delegation Framework managers on Base (current default 0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3). chainId 8453 only."),
            expectedDelegator: EvmAddress.optional().describe("Required for erc7710_delegation. The principal address the caller asserts authorized this agent. The condition fails unless the delegation's declared delegator matches. Without it a self-delegation would read as authority, so there is no structural-only mode."),
            delegation: z.object({
              delegator: EvmAddress.describe("Principal address that signed the delegation. Must equal expectedDelegator."),
              delegate: EvmAddress.describe("Agent wallet the delegation authorizes. Must equal the attested wallet."),
              authority: Bytes32.describe("Root authority only (0xffff…ffff, 32 bytes of 0xff). Delegation chains are unsupported."),
              caveats: z.array(z.object({
                enforcer: EvmAddress.describe("Caveat enforcer contract address"),
                terms: HexData(20000).describe("ABI-encoded caveat terms (hex)"),
              })).max(16).describe("Caveats the principal signed (max 16). Every enforcer must be recognized or the condition fails, with no override."),
              salt: z.union([UintString, z.number().int().nonnegative()]).transform((v) => String(v)).describe("Delegation salt (decimal string; numbers coerced)"),
              signature: HexData(20000).describe("EIP-712 signature over the delegation (hex). EOA recovery, or ERC-1271 for smart-contract principals."),
            }).optional().describe("Required for erc7710_delegation. The signed ERC-7710 delegation to evaluate. Met iff ALL of: attested wallet is the delegate; declared delegator is expectedDelegator; EIP-712 signature verifies (EOA or ERC-1271); unrevoked at the anchored block; every caveat enforcer recognized; any time-window caveat currently satisfied. Recognized enforcers: timestamp (evaluated), erc20_transfer_amount, native_transfer_amount, allowed_targets, limited_calls (the last four are REPORTED as declaredLimits: redemption enforces them, the attestation does not simulate enforcement)."),
          })
        )
        .min(1)
        .max(10)
        .describe("1-10 on-chain conditions to verify"),
    },
    { title: "Verify wallet conditions (signed)", ...SPENDS },
    async (args) => {
      const refusal = await gate("/attest");
      if (refusal) return refusal;
      const result = await apiCall("POST", "/attest", args);
      return formatResult(result);
    }
  );

  tool(
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

  tool(
    "insumer_wallet_trust",
    `Generate a signed wallet trust fact profile for an EVM wallet: a curated set of presence checks organized into dimensions (stablecoins, governance, nfts, staking, institutional_stablecoins, tokenized_treasuries, stablecoin_deposits, wrapped_bitcoin, names, account): 155 base checks across 27 chains in 10 dimensions. Optional Solana, XRPL, Bitcoin and Tron wallets add their own dimensions, up to 176 checks across 29 chains in 14 dimensions; optional Stellar and Sui wallets let rows inside existing dimensions evaluate. Dimensions arrive in a fixed order: the base dimensions as listed, then any of solana, xrpl, bitcoin and tron that were switched on, in that order. The account dimension holds two rows per chain on Ethereum, Base, Arbitrum, Optimism and Polygon: contract code at the wallet address, and an EIP-7702 delegation there; a plain key reads false on both, and which contract is never named. Rows on a chain whose wallet is not supplied stay in the signed profile with evaluated: false. Every check is held or not held (present or not present in the account dimension), never a balance. The signed conditionSetVersion (currently 2026-10-08) names the check list that was run; log it, never reject on it. Returns per-dimension pass/fail counts and an overall summary: no score, no opinion. Designed for AI agent-to-agent trust decisions. Costs 3 credits (6 with proof: 'merkle'). An rpc_failure error (503) means a read did not complete and nothing was signed: retry, and never treat it as a no. ${COUNTS_NOTE}`,
    {
      wallet: EvmAddress.describe("EVM wallet address (0x...) to profile"),
      solanaWallet: SolanaAddress.optional().describe("Solana wallet address (base58). If provided, adds the Solana dimension and lets the institutional rows on Solana evaluate."),
      xrplWallet: XrplAddress.optional().describe("XRPL wallet address (r-address). If provided, adds the XRPL dimension and lets the institutional row on XRPL evaluate."),
      bitcoinWallet: BitcoinAddress.optional().describe("Bitcoin address. If provided, adds the Bitcoin dimension (native BTC presence)."),
      tronWallet: TronAddress.optional().describe("Tron wallet address (T-prefixed). If provided, adds the Tron dimension."),
      stellarWallet: StellarAddress.optional().describe("Stellar wallet address (G-prefixed). If provided, lets the institutional rows on Stellar evaluate (classic trustlines). Adds no dimension."),
      suiWallet: SuiAddress.optional().describe("Sui wallet address (0x + 64 hex). If provided, lets the rows on Sui evaluate. Adds no dimension."),
      proof: z.enum(["merkle"]).optional().describe("Set to 'merkle' for EIP-1186 Merkle storage proofs on EVM token checks (6 credits). Rows whose balance is computed rather than stored (Aave aTokens, BUIDL), NFT/non-EVM rows and the account rows are declined with a reason (an account proof is available from the attest tool's account_code condition); the premium is refunded whenever no proof is delivered."),
    },
    { title: "Wallet trust profile (signed)", ...SPENDS },
    async (args) => {
      const refusal = await gate("/trust");
      if (refusal) return refusal;
      const result = await apiCall("POST", "/trust", args);
      return formatResult(result);
    }
  );

  tool(
    "insumer_batch_wallet_trust",
    "Generate wallet trust fact profiles for up to 10 wallets in a single request. Faster than sequential calls. Each wallet gets an independently signed profile with its own TRST-XXXXX ID: 155 base checks across 27 chains in 10 dimensions (stablecoins, governance, nfts, staking, institutional_stablecoins, tokenized_treasuries, stablecoin_deposits, wrapped_bitcoin, names, account), up to 176 checks across 29 chains in 14 dimensions with the optional Solana, XRPL, Bitcoin and Tron wallets; the signed conditionSetVersion (currently 2026-10-08) names the check list. Dimensions arrive in a fixed order, identical for every wallet in the batch: the base dimensions as listed, then any of solana, xrpl, bitcoin and tron that were switched on, in that order. Supports partial success: failed wallets get error entries while successful ones return full profiles. Costs 3 credits per successful wallet (6 with proof: 'merkle'); credits are charged only for successful profiles, while a pay-per-call (x402) payment covers every wallet in the request. A wallet whose reads did not complete gets an error entry and no signed profile: retry that wallet, and never treat the entry as a no. Each profile lists every check, so the response is large; by default the text is a summary per wallet (profile ID, held / not held / not evaluated counts, and the checks held in each dimension, in the fixed dimension order; the account dimension's checks are present rather than held), and the complete signed profiles are returned unchanged as structuredContent. Set detail to 'full' on the call to get the complete signed profiles as text too. Profiles cannot be fetched again, so a later call signs fresh profiles and is charged again.",
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
      detail: z
        .enum(["summary", "full"])
        .optional()
        .describe(
          "'summary' (default): the text is a short summary per wallet and the complete signed profiles are in structuredContent. 'full': the complete signed profiles as text too, tens of thousands of characters per wallet (more with optional wallets or merkle proofs). Choose it on the call that needs it: profiles cannot be fetched again, so a second call signs fresh profiles and is charged again. Not sent to the API; it does not change the price of the call."
        ),
    },
    { title: "Batch wallet trust profiles (signed)", ...SPENDS },
    async ({ detail, ...args }) => {
      const refusal = await gate("/trust/batch");
      if (refusal) return refusal;
      const result = await apiCall("POST", "/trust/batch", args);
      if (detail === "full" || !result.ok) return formatResult(result);
      const summary = summarizeBatchTrust(result as Record<string, unknown>);
      if (summary === null) return formatResult(result);
      return {
        content: [{ type: "text" as const, text: summary }],
        structuredContent: result as Record<string, unknown>,
      };
    }
  );

  // ============================================================
  // KEY DISCOVERY
  // ============================================================

  tool(
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
  // SETUP: Generate a free API key (no auth required)
  // ============================================================

  tool(
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

  tool(
    "insumer_verify",
    "Create a signed discount code (INSR-XXXXX, 30-minute expiry) for a wallet at a merchant. Returns tier and discount percentage, never raw balance amounts. A code that carries a discount costs one credit from the API key that owns the store; a 0% result is free. A caller using another key is not charged, and stores on a licensed platform are covered by its license. Paid discount codes requested with a key other than the store's owner are subject to an hourly limit (429; the message says when to try again). If the merchant has Stripe Connect, a coupon is auto-created. Takes an EVM, Solana or XRPL wallet. An rpc_failure error (503) means a read did not complete and no code was issued: retry, and never treat it as a no. Optional walletProof proves you control the EVM wallet: the response then says walletProven true, and the full discount its holdings earn applies, without the store's daily limit for unproven wallets. Without it the store's terms for unproven wallets apply, and discountIfProven shows what a proof would get.",
    {
      merchantId: MerchantId.describe("Merchant ID"),
      ...WalletFields,
      walletProof: WalletProof,
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

  tool(
    "insumer_list_merchants",
    "Browse merchants in the public directory. Filter by accepted token, verification status. Returns company name, website, tokens accepted, discount info, and walletTerms (the store's terms with and without proof of wallet control).",
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

  tool(
    "insumer_get_merchant",
    "Get full public merchant profile including token tiers, NFT collections, discount mode, verification status, and walletTerms: what the store gives a wallet with and without proof of control, so you can decide whether to sign before creating a code.",
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

  tool(
    "insumer_list_tokens",
    "List the tokens and NFT collections listed in the Insumer registry. Filter by chain, symbol, or asset type. The registry is a directory, not the list of what can be checked: an attestation can check any token on a supported chain, and NFTs on EVM chains, Solana and XRPL, whether listed or not. An empty result means nothing is listed under that filter, not that the token is unsupported.",
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

  tool(
    "insumer_check_discount",
    "Calculate discount for a wallet at a merchant. Checks on-chain balances and returns tier and discount percentage per token, never raw balance amounts. Free: does not consume credits. Takes an EVM, Solana or XRPL wallet. An rpc_failure error (503) means a read did not complete: retry, and never treat it as not eligible. The check carries no proof of wallet control, so totalDiscount is what an unproven wallet gets; walletTerms gives the store's terms, and discountIfProven (when present) is what signing would get.",
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

  tool(
    "insumer_credits",
    "Check verification credit balance, tier, and daily rate limit for the current API key.",
    {},
    { title: "Check credit balance", ...READ_ONLY },
    async () => {
      const result = await apiCall("GET", "/credits");
      return formatResult(result);
    }
  );

  tool(
    "insumer_buy_key",
    `Register a new API key against a USDC, USDT, BTC, or USDT-TRC20 payment the caller has already sent (no auth required, no email). This tool does not move funds: it submits the transaction hash. Receiving addresses: EVM 0xAd982CB19aCCa2923Df8F687C0614a7700255a23, Solana 6a1mLjefhvSJX1sEX8PTnionbE9DqoYjU6F6bNkT4Ydr, Tron TC5yvwkAMakkXtUxYiu2Yn1xbBcwYuD6cn, Bitcoin bc1qg7qnerdhlmdn899zemtez5tcx2a2snc0dt9dt0 (1 confirmation required). USDC/USDT auto-detected from the transaction; BTC converted to USD at market rate. One key per wallet; existing keys are topped up with a credit purchase instead. Non-refundable. ${PRICING_NOTE}`,
    {
      txHash: TxHash.describe("Transaction hash proving payment"),
      chainId: UsdcChainIdWithBitcoin,
      amount: z.number().min(5).optional().describe("Stablecoin amount sent (minimum 5). Not required for BTC: USD value derived from on-chain amount at market rate."),
      appName: z.string().max(100).describe("Name for the API key (e.g. your agent or app name)"),
    },
    { title: "Register a paid API key", ...CREATES },
    async (args) => {
      const result = await publicApiCall("POST", "/keys/buy", args);
      return formatResult(result);
    }
  );

  tool(
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

  tool(
    "insumer_confirm_payment",
    "Confirm the USDC payment for an INSR discount code. The server verifies the on-chain transaction receipt.",
    {
      code: DiscountCode.describe("Discount code (e.g. INSR-A7K3M)"),
      txHash: TxHash.describe("On-chain transaction hash or Solana signature"),
      chainId: ConfirmPaymentChainId,
      amount: z.union([DecimalString, z.number()]).describe("USDC amount sent"),
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

  tool(
    "insumer_create_merchant",
    "Create a new merchant, owned by the API key that creates it. The store has no credit balance of its own: that key pays for the store's codes, scans and taps, and credits in the response is that key's balance. Limited number of merchants per API key.",
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

  tool(
    "insumer_merchant_status",
    "Get full private merchant details: credits (the owner key's balance), token configs, NFT collections, directory status, verification status, payment settings. Owner only.",
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

  tool(
    "insumer_configure_tokens",
    "Configure merchant token discount tiers. Set own token and/or partner tokens. Replaces the existing token configuration. Max 8 tokens total. Tier discounts are whole numbers from 1 to 50; a value with decimals is refused. Owner only.",
    {
      id: MerchantId.describe("Merchant ID"),
      ownToken: OwnTokenConfigSchema.nullable()
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

  tool(
    "insumer_configure_nfts",
    "Configure the NFT collections a merchant recognizes, each granting a discount or recognition only. Replaces the existing NFT configuration. Max 4 collections. Discounts are whole numbers from 1 to 50; a value with decimals is refused. Owner only.",
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

  tool(
    "insumer_configure_settings",
    "Update merchant settings: discount stacking mode, cap, the store's terms for wallets sent without proof of control, and stablecoin payment configuration. All fields optional; supplied fields replace their current values. discountCap is a whole number from 1 to 100. A wallet with proof gets the full discount their holdings earn, without the daily limit for unproven buyers. Owner only.",
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
        .describe("Maximum total discount percentage: a whole number from 1 to 100, no decimals"),
      maxUnprovenDiscount: z
        .number()
        .int()
        .min(0)
        .max(100)
        .nullable()
        .optional()
        .describe("Most a wallet without proof of control can get, in percent: 0 = no discount, null = the same as a proven wallet"),
      maxDiscountsPerWalletPerDay: z
        .number()
        .int()
        .min(1)
        .max(100)
        .nullable()
        .optional()
        .describe("Discount codes per UTC day for a wallet without proof of control; null = no limit"),
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

  tool(
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

  tool(
    "insumer_buy_merchant_credits",
    `Kept for compatibility: a store has no credit balance of its own, so a payment submitted here adds regular credits to the API key that owns the store, at a flat rate (the regular credit purchase, with volume tiers, is the usual way to top up). Submits a USDC, USDT, BTC, or USDT-TRC20 payment the caller has already sent. This tool does not move funds: it submits the transaction hash. USDC/USDT on EVM and Solana (auto-detected), USDT-TRC20 on Tron, BTC on Bitcoin (converted at market rate, 1 confirmation required). Non-refundable. Owner only. The first purchase registers the sender wallet to the API key; updateWallet: true replaces it. ${PRICING_NOTE}`,
    {
      id: MerchantId.describe("Merchant ID"),
      txHash: TxHash.describe("Transaction hash proving payment"),
      chainId: UsdcChainIdWithBitcoin,
      amount: z.number().min(5).optional().describe("Stablecoin amount sent (minimum 5). Not required for BTC."),
      updateWallet: z.boolean().optional().default(false).describe("Set true to replace the registered sender wallet"),
    },
    { title: "Add credits to the store owner key from a payment", ...OVERWRITES, idempotentHint: false },
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

  tool(
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

  tool(
    "insumer_verify_domain",
    "Check a merchant's previously requested domain verification token. The server looks for it as a DNS TXT record, HTML meta tag, or uploaded file, and marks the domain verified when found. Rate limited per merchant (429 says when to retry). Owner only.",
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

  tool(
    "insumer_acp_discount",
    "Check token-holder discount eligibility in OpenAI/Stripe Agentic Commerce Protocol (ACP) format. Returns coupon objects, applied/rejected arrays, and per-item allocations compatible with ACP checkout flows. The on-chain check is the same one behind INSR discount codes, wrapped in ACP format. A code that carries a discount costs one credit from the API key that owns the store; a 0% result is free. A caller using another key is not charged, and stores on a licensed platform are covered by its license. Paid discount codes requested with a key other than the store's owner are subject to an hourly limit (429; the message says when to try again). Takes an EVM, Solana or XRPL wallet. An rpc_failure error (503) means a read did not complete and nothing was signed: retry, and never treat it as a no. Optional walletProof proves you control the EVM wallet: the response then says walletProven true, and the full discount its holdings earn applies, without the store's daily limit for unproven wallets. Without it the store's terms for unproven wallets apply, and discountIfProven shows what a proof would get.",
    {
      merchantId: MerchantId.describe("Merchant ID"),
      ...WalletFields,
      walletProof: WalletProof,
      items: LineItems,
    },
    { title: "Discount in ACP format", ...SPENDS },
    async (args) => {
      const result = await apiCall("POST", "/acp/discount", args);
      return formatResult(result);
    }
  );

  tool(
    "insumer_ucp_discount",
    "Check token-holder discount eligibility in Google Universal Commerce Protocol (UCP) format. Returns title, extension field, and applied array compatible with UCP checkout flows. The on-chain check is the same one behind INSR discount codes, wrapped in UCP format. A code that carries a discount costs one credit from the API key that owns the store; a 0% result is free. A caller using another key is not charged, and stores on a licensed platform are covered by its license. Paid discount codes requested with a key other than the store's owner are subject to an hourly limit (429; the message says when to try again). Takes an EVM, Solana or XRPL wallet. An rpc_failure error (503) means a read did not complete and nothing was signed: retry, and never treat it as a no. Optional walletProof proves you control the EVM wallet: the response then says walletProven true, and the full discount its holdings earn applies, without the store's daily limit for unproven wallets. Without it the store's terms for unproven wallets apply, and discountIfProven shows what a proof would get.",
    {
      merchantId: MerchantId.describe("Merchant ID"),
      ...WalletFields,
      walletProof: WalletProof,
      items: LineItems,
    },
    { title: "Discount in UCP format", ...SPENDS },
    async (args) => {
      const result = await apiCall("POST", "/ucp/discount", args);
      return formatResult(result);
    }
  );

  tool(
    "insumer_validate_code",
    "Validate an INSR-XXXXX discount code. For merchant backends during ACP/UCP checkout to confirm code validity, discount percent, and expiry. Returns valid/invalid status with reason, and walletProven (whether the code went to a caller that proved control of the wallet). No authentication required, no credits consumed. Does not expose wallet or token data.",
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

  return { server, warnings };
}
