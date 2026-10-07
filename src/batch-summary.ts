// A batch trust response carries up to ten complete signed profiles, tens of
// thousands of characters each, which is more than a model can read from one
// tool result. summarizeBatchTrust turns the response into a short text for the
// model: per wallet, the profile ID, the held / not held / not evaluated counts,
// and the checks held in each dimension. The signed profiles themselves are not
// changed; the tool returns them unchanged as structuredContent.

type Check = { label?: unknown; met?: unknown; evaluated?: unknown };
type Dimension = { checks?: unknown; total?: unknown };
type Entry = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// The API returns creditsCharged 0 and creditsRemaining null when the call was
// paid per call with x402. That payment covers every wallet in the request.
function paidPerCall(meta: Record<string, unknown>): boolean {
  return meta.creditsRemaining === null && meta.creditsCharged === 0;
}

function dimensionLine(name: string, dim: Dimension): string {
  const checks: Check[] = Array.isArray(dim.checks) ? (dim.checks as Check[]).filter(isObject) : [];
  const held = checks.filter((c) => c.met === true).map((c) => str(c.label));
  const notEvaluated = checks.filter((c) => c.evaluated === false).length;
  const total = typeof dim.total === "number" ? dim.total : checks.length;
  let line = `   ${name}: ${held.length} of ${total} held`;
  if (notEvaluated > 0) line += ` (${notEvaluated} not evaluated)`;
  if (held.length > 0) line += `: ${held.join(", ")}`;
  return line;
}

function profileLines(index: number, entry: Entry, trust: Record<string, unknown>): string[] {
  const summary = isObject(trust.summary) ? trust.summary : {};
  const signed = typeof entry.sig === "string" && entry.sig !== "" && typeof entry.kid === "string" && entry.kid !== "";
  const signature = signed
    ? `signed (${str(entry.kid)}${entry.pqKid ? ` + ${str(entry.pqKid)}` : ""})`
    : "returned without a signature: do not rely on it";
  const lines = [
    `${index}. ${str(trust.wallet)} · ${str(trust.id)} · check set ${str(trust.conditionSetVersion)} · expires ${str(trust.expiresAt)} · ${signature}`,
    `   ${str(summary.totalChecks)} checks: ${str(summary.totalPassed)} held, ${str(summary.totalFailed)} not held, ${str(summary.totalNotEvaluated)} not evaluated`,
  ];
  const dims = isObject(trust.dimensions) ? trust.dimensions : {};
  for (const [name, dim] of Object.entries(dims)) {
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
  const signedCount = results.filter((e) => isObject(e) && isObject(e.trust)).length;
  const requested = typeof counts.requested === "number" ? counts.requested : results.length;
  const succeeded = typeof counts.succeeded === "number" ? counts.succeeded : signedCount;
  const failed = typeof counts.failed === "number" ? counts.failed : results.length - signedCount;
  const perCall = paidPerCall(meta);

  const out = [
    `Batch trust profiles: ${requested} requested, ${succeeded} signed, ${failed} not signed. ${perCall ? "Paid per call: the payment covered every wallet requested." : `Credits charged: ${str(meta.creditsCharged)}.`}`,
    "This text is a summary for reading. Each signed profile (trust object, sig and kid, pqSig and pqKid) is in this result's structuredContent, unchanged, and verifies against the keys from insumer_jwks. Profiles cannot be fetched again, so a new call with detail: \"full\" signs fresh profiles and is charged again.",
    "Every check is held or not held, never a balance. The counts are facts about the wallet, not a score.",
    "",
  ];
  results.forEach((entry, i) => {
    const e: Entry = isObject(entry) ? entry : {};
    const lines = isObject(e.trust) ? profileLines(i + 1, e, e.trust) : errorLines(i + 1, e, perCall);
    out.push(...lines, "");
  });
  return out.join("\n").trimEnd();
}
