/**
 * What a metered call would cost the caller, for a hosted deployment on a
 * shared key. There the shared key pays and the caller pays nothing, so the
 * key's own charge (meta.creditsCharged) means nothing to them. In its place
 * each result states the call's price on the caller's own API key and by x402
 * pay-per-call, from InsumerAPI's published prices:
 *
 *   credits: attest 1 (2 with proof), trust 3 (6), batch trust 3 per wallet (6)
 *   prepaid: from $0.04 a credit
 *   x402:    $0.05 a credit, USDC, no signup, charged for the whole request
 *
 * The signed payload is never touched: only the unsigned meta envelope and an
 * extra text block change.
 */

export const DEVELOPERS_URL = "https://insumermodel.com/developers/";
const ENTRY_USD_PER_CREDIT = 0.04;
const X402_USD_PER_CREDIT = 0.05;

export type MeteredPath = "/attest" | "/trust" | "/trust/batch";

/** Credits the request is priced at, as x402 quotes it (before any refund). */
export function requestCredits(path: MeteredPath, args: Record<string, unknown>): number {
  const proof = args.proof === "merkle";
  if (path === "/attest") return proof ? 2 : 1;
  if (path === "/trust") return proof ? 6 : 3;
  const wallets = Array.isArray(args.wallets) ? args.wallets.length : 0;
  return (proof ? 6 : 3) * Math.max(wallets, 1);
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export interface HostedPricing {
  thisCall: string;
  ownKeyCredits: number;
  ownKeyUsdFrom: string;
  x402Usd: string;
  freeKey: string;
  getKey: string;
}

/**
 * The price block for one successful metered result. ownKeyCredits is what the
 * API actually charged for this result (a batch charges only signed profiles,
 * and an undelivered proof premium is refunded); x402 is the request's quoted
 * price, which covers every wallet in it.
 */
export function hostedPricing(
  path: MeteredPath,
  args: Record<string, unknown>,
  charged: unknown
): HostedPricing {
  const ownKeyCredits = typeof charged === "number" && charged >= 0 ? charged : requestCredits(path, args);
  return {
    thisCall: "No charge to you: this hosted endpoint pays from a shared daily allowance.",
    ownKeyCredits,
    ownKeyUsdFrom: usd(ownKeyCredits * ENTRY_USD_PER_CREDIT),
    x402Usd: usd(requestCredits(path, args) * X402_USD_PER_CREDIT),
    freeKey: "10 free verifications plus 100 requests a day",
    getKey: DEVELOPERS_URL,
  };
}

/** The same block as one sentence-led paragraph for the model to read. */
export function hostedPricingText(p: HostedPricing): string {
  return (
    `Pricing. ${p.thisCall} ` +
    `On your own API key this call costs ${plural(p.ownKeyCredits, "credit")}, from ${p.ownKeyUsdFrom} ` +
    `(credits start at $0.04 each and cost less at volume). Creating a key costs nothing and includes ${p.freeKey}. ` +
    `With x402 pay-per-call it costs ${p.x402Usd} in USDC, with no signup and no key. ` +
    `Get a key or pay per call: ${p.getKey}`
  );
}

/** Appended to the metered tools' descriptions on a hosted deployment. */
export const HOSTED_DESCRIPTION_NOTE =
  " On this hosted endpoint the call is paid from a shared daily allowance, so the caller is not charged; the credit cost above applies on the caller's own API key, and each result states the price on a key and by x402 pay-per-call.";
