// Checks an x402 quote before the payment wallet signs anything.
//
// The quote comes from the network, so it is not trusted: a proxy or a
// compromised endpoint could ask for more money, a different token, or a
// different recipient. A payment is signed only when the Base entry pays
// InsumerAPI's own receiving address, in Base USDC, under the "exact" scheme,
// for no more than the cap. Anything else is refused before signing.

export const BASE_NETWORK = "eip155:8453";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// InsumerAPI's receiving address on Base, the same address the buy tools name.
export const INSUMER_PAY_TO = "0xAd982CB19aCCa2923Df8F687C0614a7700255a23";
// Highest legitimate quote today is a 10-wallet trust batch with Merkle proofs
// ($3.00). The cap can be lowered (or raised) with INSUMER_MAX_PAYMENT_USDC.
export const DEFAULT_MAX_PAYMENT_USDC = "3";
// Cheapest paid call today (a standard attestation, $0.05). A cap below this
// refuses every paid call, so the server warns about it at startup.
export const MIN_CALL_PRICE_UNITS = 50_000n;

export interface QuoteEntry {
  amount: string;
  asset: string;
  payTo: string;
  network: string;
  scheme: string;
  extra?: { name?: string; version?: string };
}

// Parses a USDC amount such as "3" or "0.25" into 6-decimal base units.
export function parseUsdcCap(raw: string): bigint {
  const s = raw.trim();
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(s)) {
    throw new Error(
      `INSUMER_MAX_PAYMENT_USDC must be a USDC amount such as "3" or "0.25" (got "${raw}").`
    );
  }
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}

export function formatUsdc(units: bigint): string {
  const whole = units / 1_000_000n;
  const frac = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export type QuoteCheck = { ok: true; units: bigint } | { ok: false; error: string };

export function checkQuote(entry: QuoteEntry, capUnits: bigint): QuoteCheck {
  if (entry.network !== BASE_NETWORK) {
    return { ok: false, error: `Refused to pay: quote network ${entry.network} is not Base (${BASE_NETWORK}).` };
  }
  if (entry.scheme !== "exact") {
    return { ok: false, error: `Refused to pay: quote scheme "${entry.scheme}" is not "exact".` };
  }
  if (typeof entry.asset !== "string" || entry.asset.toLowerCase() !== BASE_USDC.toLowerCase()) {
    return { ok: false, error: `Refused to pay: quote asset ${entry.asset} is not USDC on Base.` };
  }
  if (typeof entry.payTo !== "string" || entry.payTo.toLowerCase() !== INSUMER_PAY_TO.toLowerCase()) {
    return { ok: false, error: `Refused to pay: quote recipient ${entry.payTo} is not InsumerAPI's receiving address.` };
  }
  if (typeof entry.amount !== "string" || !/^\d{1,30}$/.test(entry.amount)) {
    return { ok: false, error: `Refused to pay: quote amount "${entry.amount}" is not a whole number of USDC base units.` };
  }
  const units = BigInt(entry.amount);
  if (units <= 0n) {
    return { ok: false, error: "Refused to pay: quote amount is zero." };
  }
  if (units > capUnits) {
    return {
      ok: false,
      error: `Refused to pay: quote of ${formatUsdc(units)} USDC is above the cap of ${formatUsdc(capUnits)} USDC (set INSUMER_MAX_PAYMENT_USDC to change it).`,
    };
  }
  return { ok: true, units };
}
