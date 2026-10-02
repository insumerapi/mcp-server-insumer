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
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generatePrivateKey } from "viem/accounts";
import {
  BASE_NETWORK,
  BASE_USDC,
  INSUMER_PAY_TO,
  checkQuote,
  parseUsdcCap,
} from "./build/payment-guard.js";

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
const attest = tools.find((t) => t.name === "insumer_attest");
assert(attest.annotations.readOnlyHint === false, "insumer_attest is not marked read-only (it spends credits or a payment)");
const version = client.getServerVersion();
assert(version?.version === "1.14.0", `server reports version 1.14.0 (got ${version?.version})`);

console.log("\n3. Input formats");
const wallet = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const cond = { type: "token_balance", contractAddress: "native", chainId: 1, threshold: "1" };
assert(await rejects(client, "insumer_attest", { wallet: "not-an-address", conditions: [cond] }), "attest rejects a malformed EVM wallet");
assert(await rejects(client, "insumer_attest", { wallet, conditions: [{ ...cond, threshold: "1; DROP" }] }), "attest rejects a non-decimal threshold");
assert(await rejects(client, "insumer_attest", { wallet, conditions: [{ ...cond, contractAddress: "0x12<script>" }] }), "attest rejects a contract address with stray characters");
assert(await rejects(client, "insumer_wallet_trust", { wallet, solanaWallet: "0OIl" }), "trust rejects a malformed Solana wallet");
assert(await rejects(client, "insumer_get_merchant", { id: "../../keys" }), "merchant ID rejects path characters");
assert(await rejects(client, "insumer_request_domain_verification", { id: "acme", domain: "http://169.254.169.254/" }), "domain rejects a URL");
assert(await rejects(client, "insumer_buy_key", { txHash: "abc", chainId: 8453, appName: "x" }), "buy_key rejects a malformed transaction hash");
assert(await rejects(client, "insumer_confirm_payment", { code: "INSR-1", txHash: "0x" + "a".repeat(64), chainId: 8453, amount: "5" }), "confirm_payment rejects a malformed code");

console.log("\n4. Free live calls");
const jwks = await client.callTool({ name: "insumer_jwks", arguments: {} });
assert(!jwks.isError && /insumer-attest-v1/.test(text(jwks)), "insumer_jwks returns the live key set");
const merchants = await client.callTool({ name: "insumer_list_merchants", arguments: { limit: 1 } });
assert(!merchants.isError, "insumer_list_merchants answers");
const code = await client.callTool({ name: "insumer_validate_code", arguments: { code: "INSR-ZZZZZ" } });
assert(/valid/i.test(text(code)), "insumer_validate_code answers for a well-formed code");
const noCreds = await client.callTool({ name: "insumer_attest", arguments: { wallet, conditions: [cond] } });
assert(noCreds.isError && /No credentials/.test(text(noCreds)), "attest without credentials says so and sends nothing paid");
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
