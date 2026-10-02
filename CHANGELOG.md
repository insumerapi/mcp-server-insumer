# Changelog

## 1.15.0 (2026-10-02)

- **The server can be hosted.** `createInsumerServer(options)` is exported from the package root and builds a configured server for any transport; the stdio binary is unchanged (`npx -y mcp-server-insumer` behaves exactly as before). `node build/http.js` serves it over MCP streamable HTTP, stateless, for deployments that are reached by URL.
- **Hosted mode serves a subset.** `HOSTED_TOOLS` names the ten tools that make sense on a shared key with no caller identity: the signing keys, attest, compliance templates, wallet trust and batch trust, the merchant and token directories, the free discount check and code validation. Key and credit management, merchant management, discount creation and the credit balance are not served. `options.tools` sets any other list.
- **A deployment can gate metered calls.** `options.beforeMeteredCall(path)` runs before attest, trust and batch trust; returning a message refuses the call and sends nothing. The HTTP runner uses it for a per-process daily allowance (`INSUMER_DAILY_CAP`, default 200).
- `options.hideKeyMeta` drops `meta.creditsRemaining` from responses, so a shared key's balance never reaches callers of a hosted endpoint. Local installs are unchanged.
- Configuration warnings are returned from `createInsumerServer` instead of printed, so a host decides where they go. The stdio binary still prints them to stderr.
- Tests cover hosted mode: the tool subset, the cap refusal, and a free call over HTTP.

## 1.14.1 (2026-10-02)

- The MCP Registry entry moves to `com.insumermodel/insumer`, verified through the insumermodel.com domain instead of a personal GitHub account. The npm package name, the tools and the code are unchanged; `npx -y mcp-server-insumer` keeps working as before. The previous registry name, `io.github.douglasborthwick-crypto/insumer`, is deprecated with a pointer here.

## 1.14.0 (2026-10-02)

- **Pay-per-call checks every quote before signing.** With `INSUMER_PAYMENT_KEY` set, the server used to sign whatever amount, recipient and token a 402 quote named. It now signs only when the quote pays InsumerAPI's own receiving address, in USDC on Base, under the `exact` scheme, for no more than a cap: $3.00 per call by default (the largest legitimate call today), adjustable with `INSUMER_MAX_PAYMENT_USDC`. Anything else is refused and nothing is signed. A malformed cap turns pay-per-call off instead of falling back to the default; a cap below the cheapest call ($0.05) triggers a startup warning.
- **Every tool declares MCP annotations** (`title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). Read-only is claimed only by tools that change nothing and spend nothing; tools that spend credits or a payment, or create records, are not read-only; tools that replace existing configuration are marked destructive.
- **Every free-text input has a format and a length limit**: wallet addresses per chain, contract addresses and coin types, transaction hashes, merchant IDs, domains, discount codes, decimal amounts, hex data. Malformed input is rejected before any request is sent; the API still validates server-side.
- Tool descriptions say what each tool does without telling the agent to call another tool, and point to llms.txt and the pricing page for counts and prices that change, instead of carrying them.
- The buy tools say plainly that they submit a transaction hash and move no funds themselves.
- The server reports its own version correctly (it said 1.13.8).
- `server.json` lists `INSUMER_PAYMENT_KEY` and `INSUMER_MAX_PAYMENT_USDC`, and marks `INSUMER_API_KEY` optional, since either credential works.
- Tests now run against the built server over MCP: the payment guard (including a live refusal with an unfunded wallet), annotations, input formats, and free live calls. `npm test`.

## 1.13.9 (2026-10-01)

- Trust profile text follows the 2026-10-01 condition-set expansion, already live on `/v1/trust` and `/v1/trust/batch`: 145 base checks across 27 chains in 9 dimensions (adds tokenized_treasuries, stablecoin_deposits, wrapped_bitcoin and names; widens stablecoins to ten issuers on 23 EVM chains, governance to eight tokens, staking to five), up to 166 across 29 chains in 13 with the optional Solana (now a 14-check dimension), XRPL (RLUSD, USDC, OUSG), Bitcoin and Tron (USDT, USD1, WBTC) wallets. Stellar and Sui wallets add no dimension; their rows sit inside base dimensions and carry `evaluated: false` when the wallet is absent. `conditionSetVersion` is described as the dated set id (`2026-10`) that names the check list run; readers log it and never reject on it. Proof mode: computed-balance rows (Aave aTokens, BUIDL) are declined with a reason and the premium refunded. Tool descriptions, per-wallet parameter text, README, SKILL.md and the package description updated; no code path changed.

## 1.13.8 (2026-09-25)

- The repository moved to the insumerapi GitHub organization: repository, security-reporting and source links point to github.com/insumerapi/mcp-server-insumer. No code changes; the registry name is unchanged.

## 1.13.7 (2026-09-25)

- README only, no code changes. The opening line states what a verifier can check: every result is signed and checkable offline against the published keys, and on EVM chains an optional Merkle proof lets the verifier check the balance against the block header without trusting the API. It no longer says no trust in the API provider is needed, which held only for the Merkle-proof case.
- Drops the closed langchain-community PR from the list of other distribution channels.

## 1.13.6 (2026-09-21)

- `insumer_configure_tokens` / `insumer_configure_nfts`: the chain field now matches what the merchant registry accepts, all 31 EVM chains (adds Taiko, Ronin, Viction and Arc) plus Solana and XRPL. Bitcoin, Tron, Stellar and Sui are no longer offered; the registry rejects them with a 400.
- `insumer_configure_tokens`: `decimals` is required (0-18). The description said "default 18", but the registry rejects a token config without it.

## 1.13.5 (2026-09-21)

- Aligns the trust profile counts with the engine as of 2026-09-21, when USDC on Arc became a trust check: 45 base checks across 26 chains in 5 dimensions (was 44 across 25), up to 50 across 28 chains in 9 dimensions with the optional wallets (was 49 across 27). The stablecoin dimension is USDC + USDT across 22 EVM chains.
- Pay-per-call: the x402 client now picks the Base entry of the quote by network, not by position. Quotes list five settlement networks since Arc was added; this client pays on Base only, as before.

## 1.13.4 (2026-09-20)

- Aligns chain counts with the engine: 37 chains, 31 EVM; NFT ownership on 33. SKILL.md lists all 37, including Arc.
- Removes Moonbeam and Moonriver, which the engine retired on 2026-09-20. The merchant onboarding set is now 27 EVM chains.
- Clarifies that `decimals` on `insumer_attest` conditions is an optional cross-check: leave it out and the token's own decimals are read from the chain. A value that differs is rejected with a 400.
- Clarifies `contractAddress`: `native` is for `token_balance` and `ratio_to_amount` only, `nft_ownership` needs the NFT contract address, and native SUI is `0x2::sui::SUI`.
- Updates the Merkle proof wording: available on 27 of the 31 EVM chains (not ZKsync Era, Sei, Viction or XDC Network).
- Updates the SKILL.md `insumer_jwks` entry: five entries over two keys, matched by `kid` or `pqKid`.

## 1.13.3 (2026-09-02)

- Adds the post-quantum companion to the README: every attest and trust response since 2026-09-01 carries `pqSig`/`pqKid` beside `sig`/`kid`, and `pqJwt` beside `jwt`. The worked example now shows a P1363 `sig` and the companion fields.
- Enhances the signing note so the preimage matches the `kid` shown: `insumer-attest-v2` signs the domain-tagged canonical preimage; `insumer-attest-v1` signs bare insertion-order JSON.
- Enhances the `insumer_jwks` tool description and README entry: five JWKS entries over two keys (three EC kids, two RFC 9964 `AKP` kids), matched by `kid` or `pqKid`, never by position.
- Strengthens the verification guidance: `insumer-verify` 1.8.1+ reports five verdicts, the post-quantum companion being the fifth.
- Aligns `server.json` with the npm version so the MCP registry entry tracks the published package. SKILL.md lists all 38 chains.
