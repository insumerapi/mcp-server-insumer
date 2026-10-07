/**
 * Tests for mcp-server-insumer. Run after `npm run build`:
 *
 *   node test.mjs
 *
 * 1. The x402 payment guard, as a unit.
 * 2. The built server over MCP stdio: tool list, annotations, descriptions.
 * 3. Input formats are enforced before any request is sent.
 * 4. Free live calls against the real API still work.
 * 5. The live pay-per-call path refuses a quote above the cap before signing.
 *    It uses a freshly generated, unfunded wallet, so no money can move.
 * 6. Hosted mode: the HTTP runner serves the HOSTED_TOOLS subset and enforces
 *    the daily cap before anything is sent.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generatePrivateKey } from "viem/accounts";
import { readFileSync } from "node:fs";
const PKG_VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
import {
  BASE_NETWORK,
  BASE_USDC,
  INSUMER_PAY_TO,
  checkQuote,
  parseUsdcCap,
} from "./build/payment-guard.js";
import { summarizeBatchTrust } from "./build/batch-summary.js";

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name}`);
    failed++;
  }
}

// ---------------------------------------------------------------
console.log("\n1. Payment guard");
// A real Base entry from a live /v1/attest quote (2026-10-02).
const good = { network: BASE_NETWORK, scheme: "exact", asset: BASE_USDC, payTo: INSUMER_PAY_TO, amount: "50000", extra: { name: "USD Coin", version: "2" } };
const cap = parseUsdcCap("3");
assert(cap === 3_000_000n, "cap '3' parses to 3,000,000 base units");
assert(parseUsdcCap("0.25") === 250_000n, "cap '0.25' parses to 250,000 base units");
for (const bad of ["", "abc", "-1", "1.2345678", "1e3", "3 USDC"]) {
  let threw = false;
  try { parseUsdcCap(bad); } catch { threw = true; }
  assert(threw, `cap "${bad}" is rejected`);
}
assert(checkQuote(good, cap).ok === true, "live-shaped $0.05 quote is accepted");
assert(checkQuote({ ...good, payTo: good.payTo.toLowerCase() }, cap).ok === true, "recipient match ignores address case");
assert(checkQuote({ ...good, amount: "3000000" }, cap).ok === true, "quote exactly at the cap is accepted");
assert(checkQuote({ ...good, amount: "3000001" }, cap).ok === false, "quote one unit above the cap is refused");
assert(checkQuote({ ...good, payTo: "0x000000000000000000000000000000000000dEaD" }, cap).ok === false, "wrong recipient is refused");
assert(checkQuote({ ...good, asset: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb" }, cap).ok === false, "wrong token is refused");
assert(checkQuote({ ...good, network: "eip155:1" }, cap).ok === false, "wrong network is refused");
assert(checkQuote({ ...good, scheme: "upto" }, cap).ok === false, "non-exact scheme is refused");
assert(checkQuote({ ...good, amount: "0" }, cap).ok === false, "zero amount is refused");
assert(checkQuote({ ...good, amount: "1.5" }, cap).ok === false, "fractional base units are refused");
assert(checkQuote({ ...good, amount: "-5" }, cap).ok === false, "negative amount is refused");
assert(checkQuote({ ...good, amount: undefined }, cap).ok === false, "missing amount is refused");

// ---------------------------------------------------------------
console.log("\n1b. Batch trust summary");
// Shaped like a live /v1/trust/batch response: one signed profile, one wallet
// whose reads did not complete.
const row = (label, met, extra = {}) => ({ label, chainId: 1, met, conditionHash: "0x00", ...extra });
const batch = {
  ok: true,
  data: {
    results: [
      {
        trust: {
          id: "TRST-AAAAA", wallet: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", conditionSetVersion: "2026-10-08",
          expiresAt: "2026-10-07T19:32:38.129Z",
          dimensions: {
            stablecoins: { checks: [row("USDC on Ethereum", true), row("USDT on Ethereum", false)], passCount: 1, failCount: 1, notEvaluatedCount: 0, total: 2 },
            institutional_stablecoins: { checks: [row("USDC on Solana", false, { evaluated: false, reason: "wallet not supplied" })], passCount: 0, failCount: 0, notEvaluatedCount: 1, total: 1 },
          },
          summary: { totalChecks: 3, totalPassed: 1, totalFailed: 1, totalNotEvaluated: 1, dimensionsWithActivity: 1, dimensionsChecked: 2 },
        },
        sig: "c2ln", kid: "insumer-trust-v2", pqSig: "cHE=", pqKid: "insumer-trust-pq1",
      },
      { error: { wallet: "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D", message: "rpc_failure" } },
    ],
    summary: { requested: 2, succeeded: 1, failed: 1 },
  },
  meta: { creditsCharged: 3 },
};
const summaryText = summarizeBatchTrust(batch);
assert(summaryText.startsWith("Batch trust profiles: 2 requested, 1 signed, 1 not signed. Credits charged: 3."), "summary opens with the batch counts and credits");
assert(summaryText.includes("1. 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 · TRST-AAAAA · check set 2026-10-08"), "summary names each wallet in full with its profile ID and check set");
assert(summaryText.includes("signed (insumer-trust-v2 + insumer-trust-pq1)"), "summary names the kids that signed the profile");
assert(summaryText.includes("3 checks: 1 held, 1 not held, 1 not evaluated"), "summary carries the profile's own counts");
assert(summaryText.includes("stablecoins: 1 of 2 held: USDC on Ethereum") && !summaryText.includes("USDT on Ethereum"), "summary lists only the checks held");
assert(summaryText.includes("institutional_stablecoins: 0 of 1 held (1 not evaluated)"), "summary counts the checks not evaluated");
assert(summaryText.includes("2. 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D · not signed: rpc_failure") && summaryText.includes("never read this entry as a no"), "a wallet whose reads did not complete is reported as not signed, never as a no");
assert(summaryText.includes("structuredContent") && summaryText.includes('detail: "full"'), "summary says where the signed profiles are and how to get them as text");
assert(!summaryText.includes("c2ln") && !summaryText.includes("cHE="), "summary does not repeat the signatures it cannot carry the signed bytes for");
assert(summarizeBatchTrust({ ok: true, data: { results: [], summary: { requested: 0, succeeded: 0, failed: 0 } }, meta: {} }).startsWith("Batch trust profiles: 0 requested"), "an empty batch still summarizes");
assert(summaryText.includes("No credits were charged for it.") && summaryText.includes("charged again"), "credit-paid batch: an unsigned wallet costs nothing, and a second call is charged again");
const perCallText = summarizeBatchTrust({ ...batch, meta: { creditsCharged: 0, creditsRemaining: null } });
assert(perCallText.includes("Paid per call: the payment covered every wallet requested.") && !perCallText.includes("Credits charged") && !perCallText.includes("No credits were charged"), "x402-paid batch: says the payment covered every wallet, never that nothing was charged");
const unsigned = summarizeBatchTrust({ ok: true, data: { results: [{ trust: batch.data.results[0].trust }], summary: { requested: 1, succeeded: 1, failed: 0 } }, meta: { creditsCharged: 3 } });
assert(unsigned.includes("returned without a signature: do not rely on it") && !unsigned.includes("signed ("), "a profile without sig and kid is never shown as signed");
assert(summarizeBatchTrust({ ok: true }) === null && summarizeBatchTrust({ ok: true, data: { results: "x" } }) === null, "a body with no results array is not summarized");
let crashed = false;
try { for (const odd of [{ ok: true, data: { results: [null, "x", 1, { trust: null }, { error: "boom" }, { trust: { dimensions: "x" } }] } }]) summarizeBatchTrust(odd); } catch { crashed = true; }
assert(!crashed, "malformed entries do not crash the summary");

// Dimension order, the account dimension's wording, and the signature guards.
// Two wallets whose dimensions arrive in different orders (the second also
// carries an unknown dimension and the optional ones out of order) must print
// in the same fixed order.
const accountDim = { checks: [row("Contract code on Ethereum", true), row("EIP-7702 delegation on Ethereum", false), row("Contract code on Base", true), row("EIP-7702 delegation on Base", false)], passCount: 2, failCount: 2, notEvaluatedCount: 0, total: 4 };
const namesDim = { checks: [row("ENS name", true)], passCount: 1, failCount: 0, notEvaluatedCount: 0, total: 1 };
const solanaDim = { checks: [row("USDC on Solana", false)], passCount: 0, failCount: 1, notEvaluatedCount: 0, total: 1 };
const tronDim = { checks: [row("USDT on Tron", false)], passCount: 0, failCount: 1, notEvaluatedCount: 0, total: 1 };
const zzzDim = { checks: [row("Something on Ethereum", false)], passCount: 0, failCount: 1, notEvaluatedCount: 0, total: 1 };
const inOrder = { stablecoins: batch.data.results[0].trust.dimensions.stablecoins, names: namesDim, account: accountDim, solana: solanaDim, tron: tronDim };
const shuffled = { zzz_future: zzzDim, tron: tronDim, account: accountDim, solana: solanaDim, names: namesDim, aaa_future: zzzDim, stablecoins: batch.data.results[0].trust.dimensions.stablecoins };
const profile = (id, dimensions) => ({ trust: { ...batch.data.results[0].trust, id, dimensions }, sig: "c2ln", kid: "insumer-trust-v2", pqSig: "cHE=", pqKid: "insumer-trust-pq1" });
const ordered = summarizeBatchTrust({ ok: true, data: { results: [profile("TRST-ORDER", inOrder), profile("TRST-SHUFF", shuffled)], summary: { requested: 2, succeeded: 2, failed: 0 } }, meta: { creditsCharged: 6 } });
const dimensionNames = (text, id) => text.split(`· ${id} ·`)[1].split("\n\n")[0].split("\n").slice(2).map((l) => l.trim().split(":")[0]);
const withAccount = summarizeBatchTrust({ ok: true, data: { results: [{ ...profile("TRST-SPLIT", inOrder), trust: { ...profile("TRST-SPLIT", inOrder).trust, summary: { totalChecks: 9, totalPassed: 4, totalFailed: 4, totalNotEvaluated: 1, dimensionsWithActivity: 3, dimensionsChecked: 5 } } }], summary: { requested: 1, succeeded: 1, failed: 0 } }, meta: { creditsCharged: 3 } });
assert(withAccount.includes("9 checks: 2 assets held, 2 account facts present, 4 not held, 1 not evaluated"), "account facts are counted beside the assets, never added to them");
assert(summaryText.includes("3 checks: 1 held, 1 not held, 1 not evaluated"), "a profile without an account dimension keeps the plain count");
assert(dimensionNames(ordered, "TRST-ORDER").join(",") === "stablecoins,names,account,solana,tron", `dimensions print in the fixed order (got ${dimensionNames(ordered, "TRST-ORDER").join(",")})`);
assert(dimensionNames(ordered, "TRST-SHUFF").join(",") === "stablecoins,names,account,solana,tron,aaa_future,zzz_future", `a profile whose dimensions arrive in another order prints in the same fixed order, unknown names last alphabetically (got ${dimensionNames(ordered, "TRST-SHUFF").join(",")})`);
assert(dimensionNames(ordered, "TRST-ORDER").join(",") === dimensionNames(ordered, "TRST-SHUFF").slice(0, 5).join(","), "every wallet in a batch prints its known dimensions in the same order");
assert(ordered.includes("account: 2 of 4 present: Contract code on Ethereum, Contract code on Base") && !ordered.includes("account: 2 of 4 held"), "the account dimension says present, not held");
assert(ordered.includes("names: 1 of 1 held: ENS name") && ordered.includes("stablecoins: 1 of 2 held"), "the other dimensions still say held");
assert(ordered.includes("(present or not present for the account dimension)"), "the summary says the account dimension's wording");
const noPqSig = summarizeBatchTrust({ ok: true, data: { results: [{ ...batch.data.results[0], pqSig: "", pqKid: "insumer-trust-pq1" }], summary: { requested: 1, succeeded: 1, failed: 0 } }, meta: { creditsCharged: 3 } });
assert(noPqSig.includes("signed (insumer-trust-v2)") && !noPqSig.includes("insumer-trust-pq1"), "the post-quantum kid is shown only when its signature is there too");
const noKid = summarizeBatchTrust({ ok: true, data: { results: [{ ...batch.data.results[0], kid: "" }, batch.data.results[0]], summary: { requested: 2, succeeded: 2, failed: 0 } }, meta: { creditsCharged: 6 } });
assert(noKid.startsWith("Batch trust profiles: 2 requested, 1 signed, 1 not signed.") && noKid.includes("returned without a signature: do not rely on it"), "the header counts as signed only profiles with both a signature and a kid, whatever the API's own count says");
const noSig = summarizeBatchTrust({ ok: true, data: { results: [{ ...batch.data.results[0], sig: undefined }], summary: { requested: 1, succeeded: 1, failed: 0 } }, meta: { creditsCharged: 3 } });
assert(noSig.startsWith("Batch trust profiles: 1 requested, 0 signed, 1 not signed."), "a profile with a kid but no signature is not counted as signed");

// ---------------------------------------------------------------
async function connect(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["build/index.js"],
    env: { PATH: process.env.PATH ?? "", ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function text(result) {
  return (result.content ?? []).map((c) => c.text ?? "").join("\n");
}

// Calls a tool and reports whether the SDK rejected the input. Depending on SDK
// version a validation failure is either a thrown error or an isError result.
async function rejects(client, name, args) {
  try {
    const r = await client.callTool({ name, arguments: args });
    return r.isError === true && /invalid|validation|expected|must|format|regex/i.test(text(r));
  } catch (err) {
    return /invalid|validation|expected|must|format|regex/i.test(String(err?.message ?? err));
  }
}

console.log("\n2. Tool list and annotations");
const client = await connect({});
const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
assert(tools.length === 27, `27 tools listed (got ${tools.length})`);

const READ_ONLY = new Set([
  "insumer_jwks", "insumer_compliance_templates", "insumer_list_merchants", "insumer_get_merchant",
  "insumer_list_tokens", "insumer_check_discount", "insumer_credits", "insumer_merchant_status", "insumer_validate_code",
]);
const DESTRUCTIVE = new Set([
  "insumer_configure_tokens", "insumer_configure_nfts", "insumer_configure_settings",
  "insumer_buy_credits", "insumer_buy_merchant_credits",
]);
let annotated = 0, honest = 0, titled = 0, noCrossRefs = 0;
for (const t of tools) {
  const a = t.annotations ?? {};
  if (["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"].every((k) => typeof a[k] === "boolean")) annotated++;
  if (a.readOnlyHint === READ_ONLY.has(t.name) && a.destructiveHint === DESTRUCTIVE.has(t.name) && a.openWorldHint === true) honest++;
  if (typeof a.title === "string" && a.title.length > 0) titled++;
  if (!names.some((n) => n !== t.name && (t.description ?? "").includes(n))) noCrossRefs++;
  else console.log(`    ${t.name} description names another tool`);
}
assert(annotated === 27, `all 27 tools carry the four hints (got ${annotated})`);
assert(honest === 27, `read-only and destructive hints match the intended classification (got ${honest})`);
assert(titled === 27, `all 27 tools have a title (got ${titled})`);
assert(noCrossRefs === 27, `no description names another tool (got ${noCrossRefs})`);
const withOutput = tools.filter((t) => t.outputSchema?.type === "object" && t.outputSchema.properties?.ok && t.outputSchema.properties?.data).length;
assert(withOutput === 27, `all 27 tools declare the result output schema (got ${withOutput})`);
const attest = tools.find((t) => t.name === "insumer_attest");
assert(attest.annotations.readOnlyHint === false, "insumer_attest is not marked read-only (it spends credits or a payment)");
const batchTool = tools.find((t) => t.name === "insumer_batch_wallet_trust");
assert(batchTool.inputSchema.properties.detail?.enum?.join(",") === "summary,full", "insumer_batch_wallet_trust offers detail: summary or full");
const version = client.getServerVersion();
assert(version?.version === PKG_VERSION, `server reports the package version ${PKG_VERSION} (got ${version?.version})`);

console.log("\n3. Input formats");
const wallet = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const cond = { type: "token_balance", contractAddress: "native", chainId: 1, threshold: "1" };
assert(await rejects(client, "insumer_attest", { wallet: "not-an-address", conditions: [cond] }), "attest rejects a malformed EVM wallet");
assert(await rejects(client, "insumer_attest", { wallet, conditions: [{ ...cond, threshold: "1; DROP" }] }), "attest rejects a non-decimal threshold");
assert(await rejects(client, "insumer_attest", { wallet, conditions: [{ ...cond, contractAddress: "0x12<script>" }] }), "attest rejects a contract address with stray characters");
assert(await rejects(client, "insumer_attest", { wallet, conditions: [{ type: "account_code", chainId: 8453, expect: "code" }] }), "attest rejects an expect outside none, eip7702 and contract");
assert(await rejects(client, "insumer_attest", { wallet, conditions: [{ type: "account_code", chainId: 8453, expect: "eip7702", delegate: "not-an-address" }] }), "attest rejects a malformed delegate");
assert(await rejects(client, "insumer_wallet_trust", { wallet, solanaWallet: "0OIl" }), "trust rejects a malformed Solana wallet");
assert(await rejects(client, "insumer_get_merchant", { id: "../../keys" }), "merchant ID rejects path characters");
assert(await rejects(client, "insumer_request_domain_verification", { id: "acme", domain: "http://169.254.169.254/" }), "domain rejects a URL");
assert(await rejects(client, "insumer_buy_key", { txHash: "abc", chainId: 8453, appName: "x" }), "buy_key rejects a malformed transaction hash");
assert(await rejects(client, "insumer_confirm_payment", { code: "INSR-1", txHash: "0x" + "a".repeat(64), chainId: 8453, amount: "5" }), "confirm_payment rejects a malformed code");

assert(await rejects(client, "insumer_attest", { xrplWallet: "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH", conditions: [{ type: "nft_ownership", contractAddress: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", chainId: "xrpl", taxon: 4294967296 }] }), "attest rejects a taxon above 4294967295");
assert(await rejects(client, "insumer_attest", { xrplWallet: "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH", conditions: [{ type: "nft_ownership", contractAddress: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", chainId: "xrpl", taxon: -1 }] }), "attest rejects a negative taxon");
assert(await rejects(client, "insumer_configure_nfts", { id: "acme", nftCollections: [{ name: "A", contractAddress: "0x" + "a".repeat(40), chainId: 1, discount: 12.5 }] }), "configure_nfts rejects a discount with decimals");
assert(await rejects(client, "insumer_configure_nfts", { id: "acme", nftCollections: [{ name: "A", contractAddress: "0x" + "a".repeat(40), chainId: 1, discount: 10, enabled: "false" }] }), "configure_nfts rejects enabled as a string");
assert(await rejects(client, "insumer_configure_settings", { id: "acme", discountCap: 12.5 }), "configure_settings rejects a cap with decimals");
assert(await rejects(client, "insumer_configure_settings", { id: "acme", maxUnprovenDiscount: 101 }), "configure_settings rejects an unproven discount above 100");
assert(await rejects(client, "insumer_configure_tokens", { id: "acme", partnerTokens: [{ symbol: "A", chainId: 1, contractAddress: "0x" + "a".repeat(40), decimals: 18, tiers: [{ name: "T", threshold: 1, discount: 5 }], alsoOn: Array.from({ length: 10 }, (_, i) => ({ chainId: 10 + i, contractAddress: "0x" + "b".repeat(40) })) }] }), "configure_tokens rejects more than 9 alsoOn networks");
assert(await rejects(client, "insumer_verify", { merchantId: "acme", wallet: "0x" + "a".repeat(40), walletProof: { message: "m", signature: "not-hex" } }), "verify rejects a walletProof signature that is not hex");
{
  const props = (name) => Object.keys(tools.find((t) => t.name === name).inputSchema.properties);
  const merchantTools = ["insumer_verify", "insumer_check_discount", "insumer_acp_discount", "insumer_ucp_discount"];
  assert(merchantTools.every((n) => ["wallet", "solanaWallet", "xrplWallet"].every((w) => props(n).includes(w)) && !props(n).some((k) => /^(tron|stellar|sui|bitcoin)Wallet$/.test(k))), "the merchant tools offer the EVM, Solana and XRPL wallets and no others");
  const desc = (name) => tools.find((t) => t.name === name).description;
  assert(["insumer_attest", "insumer_wallet_trust", ...merchantTools].every((n) => /rpc_failure/.test(desc(n))), "every tool that can answer rpc_failure says what it means");
  const nft = tools.find((t) => t.name === "insumer_configure_nfts").inputSchema.properties.nftCollections.items.properties;
  assert(nft.enabled?.type === "boolean" && Array.isArray(nft.benefitType?.enum), "configure_nfts carries enabled and benefitType");
  const own = JSON.stringify(tools.find((t) => t.name === "insumer_configure_tokens").inputSchema.properties.ownToken);
  assert(/"name"/.test(own) && /"logo"/.test(own) && /"enabled"/.test(own), "configure_tokens carries name, logo and the own token's enabled");
  const issuing = ["insumer_verify", "insumer_acp_discount", "insumer_ucp_discount"];
  assert(issuing.every((n) => props(n).includes("walletProof")) && !props("insumer_check_discount").includes("walletProof"), "the code-issuing tools take walletProof; the free check does not");
  const proofSchema = JSON.stringify(tools.find((t) => t.name === "insumer_verify").inputSchema.properties.walletProof);
  assert(/api\.insumermodel\.com\/v1\/merchants\//.test(proofSchema) && /"message"/.test(proofSchema) && /"signature"/.test(proofSchema), "walletProof states the message to sign and takes message and signature");
  const tokenProps = JSON.stringify(tools.find((t) => t.name === "insumer_configure_tokens").inputSchema.properties.partnerTokens);
  const ownProps = JSON.stringify(tools.find((t) => t.name === "insumer_configure_tokens").inputSchema.properties.ownToken);
  assert(/"alsoOn"/.test(tokenProps) && /"alsoOn"/.test(ownProps), "configure_tokens carries alsoOn on partner tokens and the own token");
  const settings = tools.find((t) => t.name === "insumer_configure_settings").inputSchema.properties;
  assert(settings.maxUnprovenDiscount && settings.maxDiscountsPerWalletPerDay, "configure_settings carries the terms for wallets without proof");
  const suiTyped = JSON.stringify(attest.inputSchema.properties.conditions.items.properties.contractAddress);
  assert(/600/.test(suiTyped), "attest accepts a Sui coin type with type parameters");
  const condProps = attest.inputSchema.properties.conditions.items.properties;
  assert(condProps.type.enum.length === 10 && condProps.type.enum.includes("account_code"), "attest offers ten condition types including account_code");
  assert(condProps.expect?.enum?.join(",") === "none,eip7702,contract" && /never returned/.test(condProps.expect.description), "attest takes expect with the three code states and says the code is never returned");
  assert(condProps.delegate && /eip7702/.test(condProps.delegate.description), "attest takes delegate, for eip7702 only");
  assert(/account_code/.test(attest.description) && /account_code/.test(attest.inputSchema.properties.proof.description), "the attest description and its proof input name account_code");
  const trustDesc = desc("insumer_wallet_trust"), batchDesc = desc("insumer_batch_wallet_trust");
  assert([trustDesc, batchDesc].every((d) => /155 base checks across 27 chains in 10 dimensions/.test(d) && /176 checks across 29 chains in 14 dimensions/.test(d) && /2026-10-08/.test(d) && /account/.test(d) && /fixed order/.test(d)), "the trust tools carry the counts, the check set version, the account dimension and the fixed order");
}

console.log("\n4. Free live calls");
const jwks = await client.callTool({ name: "insumer_jwks", arguments: {} });
assert(!jwks.isError && /insumer-attest-v1/.test(text(jwks)), "insumer_jwks returns the live key set");
const merchants = await client.callTool({ name: "insumer_list_merchants", arguments: { limit: 1 } });
assert(!merchants.isError, "insumer_list_merchants answers");
const code = await client.callTool({ name: "insumer_validate_code", arguments: { code: "INSR-ZZZZZ" } });
assert(/valid/i.test(text(code)), "insumer_validate_code answers for a well-formed code");
const sameJson = (r) => { try { return JSON.stringify(r.structuredContent) === JSON.stringify(JSON.parse(text(r))); } catch { return false; } };
assert(Array.isArray(jwks.structuredContent?.keys) && sameJson(jwks), "insumer_jwks carries the key set as structuredContent, identical to its text");
assert(merchants.structuredContent && sameJson(merchants), "insumer_list_merchants carries structuredContent identical to its text");
assert(code.structuredContent && sameJson(code), "insumer_validate_code carries structuredContent identical to its text");
const noCreds = await client.callTool({ name: "insumer_attest", arguments: { wallet, conditions: [cond] } });
assert(noCreds.isError && /No credentials/.test(text(noCreds)), "attest without credentials says so and sends nothing paid");
const noCredsBatch = await client.callTool({ name: "insumer_batch_wallet_trust", arguments: { wallets: [{ wallet }] } });
assert(noCredsBatch.isError && !noCredsBatch.structuredContent && /No credentials/.test(text(noCredsBatch)), "batch trust that fails returns the error, not a summary");
await client.close();

console.log("\n5. Live pay-per-call guard (fresh unfunded wallet, $0.01 cap)");
const payer = await connect({ INSUMER_PAYMENT_KEY: generatePrivateKey(), INSUMER_MAX_PAYMENT_USDC: "0.01" });
const refused = await payer.callTool({ name: "insumer_attest", arguments: { wallet, conditions: [cond] } });
assert(refused.isError && /above the cap of 0\.01 USDC/.test(text(refused)), "the live $0.05 quote is refused before signing");
await payer.close();

const badCap = await connect({ INSUMER_PAYMENT_KEY: generatePrivateKey(), INSUMER_MAX_PAYMENT_USDC: "lots" });
const disabled = await badCap.callTool({ name: "insumer_attest", arguments: { wallet, conditions: [cond] } });
assert(disabled.isError && /INSUMER_MAX_PAYMENT_USDC must be/.test(text(disabled)), "a malformed cap disables payments instead of falling back");
await badCap.close();

console.log("\n6. Hosted mode over streamable HTTP (HOSTED_TOOLS, daily cap 0)");
{
  const { spawn } = await import("node:child_process");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const port = 3900 + Math.floor(Math.random() * 100);
  const proc = spawn(process.execPath, ["build/http.js"], {
    env: { ...process.env, PORT: String(port), INSUMER_API_KEY: "insr_live_test", INSUMER_DAILY_CAP: "0" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  await new Promise((resolve) => proc.stderr.on("data", (d) => { if (String(d).includes("listening")) resolve(); }));
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const info = await (await fetch(url)).json();
  assert(info.ok && info.transport === "streamable-http", "a plain GET describes the endpoint");
  const http = new Client({ name: "test-http", version: "0.0.0" });
  await http.connect(new StreamableHTTPClientTransport(url));
  const hosted = (await http.listTools()).tools.map((t) => t.name);
  assert(hosted.length === 10 && hosted.includes("insumer_attest") && !hosted.includes("insumer_setup") && !hosted.includes("insumer_buy_key"), "hosted mode serves the 10 HOSTED_TOOLS and none of the key, credit or merchant tools");
  const capped = await http.callTool({ name: "insumer_attest", arguments: { wallet, conditions: [cond] } });
  assert(capped.isError && /daily allowance/.test(text(capped)), "a metered call past the cap is refused before anything is sent");
  const free = await http.callTool({ name: "insumer_jwks", arguments: {} });
  assert(!free.isError && /insumer-attest-v2/.test(text(free)), "a free tool still answers over HTTP");
  assert(Array.isArray(free.structuredContent?.keys), "the hosted transport carries structuredContent too");
  const { createInsumerServer } = await import("./build/server.js");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, data: { met: true }, meta: { version: "1.0", creditsRemaining: 9999, creditsCharged: 1 } }), { headers: { "Content-Type": "application/json" } });
  try {
    const hidden = createInsumerServer({ apiKey: "insr_live_test", hideKeyMeta: true }).server;
    const shown = createInsumerServer({ apiKey: "insr_live_test" }).server;
    const call = async (s) => { const h = s._registeredTools["insumer_attest"]; return text(await h.handler({ wallet, conditions: [cond] }, {})); };
    assert(!/creditsRemaining/.test(await call(hidden)) && /creditsCharged/.test(await call(hidden)), "hideKeyMeta removes the key's balance from responses and keeps the charge");
    assert(/creditsRemaining/.test(await call(shown)), "without hideKeyMeta the balance is still reported (local installs)");
  } finally {
    globalThis.fetch = realFetch;
  }
  await http.close();
  proc.kill();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
