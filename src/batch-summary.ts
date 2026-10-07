// A batch trust response carries up to ten complete signed profiles, tens of
// thousands of characters each, which is more than a model can read from one
// tool result. summarizeBatchTrust turns the response into a short text for the
// model: per wallet, the profile ID, the held / not held / not evaluated counts,
// and the checks held in each dimension. The signed profiles themselves are not
// changed; the tool returns them unchanged as structuredContent.

type Check = { label?: unknown; met?: unknown; evaluated?: unknown };
type Dimension = { checks?: unknown; total?: unknown };
type Entry = Record<string, unknown>;

// Dimensions print in this order whatever order they arrive in: the base
// dimensions first, then the optional wallet dimensions, then anything else by
// name. Every wallet in a batch therefore reads in the same order.
const DIMENSION_ORDER = [
  "stablecoins", "governance", "nfts", "staking", "institutional_stablecoins", "tokenized_treasuries",
  "stablecoin_deposits", "wrapped_bitcoin", "names", "account",
  "solana", "xrpl", "bitcoin", "tron",
];

// The account dimension's checks are code states (contract code, EIP-7702
// delegation), which are present or not present rather than held.
const PRESENT = new Set(["account"]);

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v !== "";
}

// The API returns creditsCharged 0 and creditsRemaining null when the call was
// paid per call with x402. That payment covers every wallet in the request.
function paidPerCall(meta: Record<string, unknown>): boolean {
  return meta.creditsRemaining === null && meta.creditsCharged === 0;
}

function orderDimensions(names: string[]): string[] {
  const rank = (n: string) => { const i = DIMENSION_ORDER.indexOf(n); return i === -1 ? DIMENSION_ORDER.length : i; };
  return [...names].sort((a, b) => rank(a) - rank(b) || (rank(a) === DIMENSION_ORDER.length ? a.localeCompare(b) : 0));
}

function dimensionLine(name: string, dim: Dimension): string {
  const checks: Check[] = Array.isArray(dim.checks) ? (dim.checks as Check[]).filter(isObject) : [];
  const held = checks.filter((c) => c.met === true).map((c) => str(c.label));
  const notEvaluated = checks.filter((c) => c.evaluated === false).length;
  const total = typeof dim.total === "number" ? dim.total : checks.length;
  const word = PRESENT.has(name) ? "present" : "held";
  let line = `   ${name}: ${held.length} of ${total} ${word}`;
  if (notEvaluated > 0) line += ` (${notEvaluated} not evaluated)`;
  if (held.length > 0) line += `: ${held.join(", ")}`;
  return line;
}

// "held" counts asset rows only. The account dimension's rows are facts about the
// address (contract code, EIP-7702 delegation), so they are reported beside the
// assets rather than added to them; a profile without that dimension keeps the
// plain count.
function heldLine(summary: Record<string, unknown>, dims: Record<string, unknown>): string {
  const account = isObject(dims.account) ? dims.account : null;
  const accountPresent = account && typeof account.passCount === "number" ? account.passCount : null;
  if (accountPresent === null || typeof summary.totalPassed !== "number" || summary.totalPassed < accountPresent) return `${str(summary.totalPassed)} held`;
  return `${summary.totalPassed - accountPresent} assets held, ${accountPresent} account facts present`;
}

function profileLines(index: number, entry: Entry, trust: Record<string, unknown>): string[] {
  const summary = isObject(trust.summary) ? trust.summary : {};
  const signed = nonEmptyString(entry.sig) && nonEmptyString(entry.kid);
  const companion = nonEmptyString(entry.pqSig) && nonEmptyString(entry.pqKid) ? ` + ${entry.pqKid}` : "";
  const signature = signed
    ? `signed (${entry.kid}${companion})`
    : "returned without a signature: do not rely on it";
  const dims = isObject(trust.dimensions) ? trust.dimensions : {};
  const lines = [
    `${index}. ${str(trust.wallet)} · ${str(trust.id)} · check set ${str(trust.conditionSetVersion)} · expires ${str(trust.expiresAt)} · ${signature}`,
    `   ${str(summary.totalChecks)} checks: ${heldLine(summary, dims)}, ${str(summary.totalFailed)} not held, ${str(summary.totalNotEvaluated)} not evaluated`,
  ];
  for (const name of orderDimensions(Object.keys(dims))) {
    const dim = dims[name];
    if (isObject(dim)) lines.push(dimensionLine(name, dim as Dimension));
  }
  return lines;
}

function errorLines(index: number, entry: Entry, perCall: boolean): string[] {
  const err = isObject(entry.error) ? entry.error : {};
  const reason = str(err.message) || str(err.code) || (typeof entry.error === "string" ? entry.error : "no reason given");
  const charge = perCall
    ? "The per-call payment covered this wallet too."
    : "No credits were charged for it.";
  return [
    `${index}. ${str(err.wallet) || "(wallet not named)"} · not signed: ${reason}`,
    `   No profile was signed for this wallet. ${charge} Retry this wallet; never read this entry as a no.`,
  ];
}

// Returns null when the response does not carry a results array, so the caller
// can fall back to the response as it came.
export function summarizeBatchTrust(response: Record<string, unknown>): string | null {
  const data = isObject(response.data) ? response.data : {};
  if (!Array.isArray(data.results)) return null;
  const meta = isObject(response.meta) ? response.meta : {};
  const results = data.results as unknown[];
  const counts = isObject(data.summary) ? data.summary : {};
  // Signed means a profile with a signature and a kid, whatever the API's own
  // success count says: a profile returned without them is not counted as signed.
  const signedCount = results.filter((e) => isObject(e) && isObject(e.trust) && nonEmptyString(e.sig) && nonEmptyString(e.kid)).length;
  const requested = typeof counts.requested === "number" ? counts.requested : results.length;
  const succeeded = signedCount;
  const failed = results.length - signedCount;
  const perCall = paidPerCall(meta);

  const out = [
    `Batch trust profiles: ${requested} requested, ${succeeded} signed, ${failed} not signed. ${perCall ? "Paid per call: the payment covered every wallet requested." : `Credits charged: ${str(meta.creditsCharged)}.`}`,
    "This text is a summary for reading. Each signed profile (trust object, sig and kid, pqSig and pqKid) is in this result's structuredContent, unchanged, and verifies against the keys from insumer_jwks. Profiles cannot be fetched again, so a new call with detail: \"full\" signs fresh profiles and is charged again.",
    "Every check is held or not held (present or not present for the account dimension), never a balance. The counts are facts about the wallet, not a score; the account facts are counted beside the assets, never added to them.",
    "",
  ];
  results.forEach((entry, i) => {
    const e: Entry = isObject(entry) ? entry : {};
    const lines = isObject(e.trust) ? profileLines(i + 1, e, e.trust) : errorLines(i + 1, e, perCall);
    out.push(...lines, "");
  });
  return out.join("\n").trimEnd();
}
