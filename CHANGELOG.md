# Changelog

## 1.19.0 (2026-10-07)

- **`insumer_batch_wallet_trust` returns a summary a model can read.** Each trust profile lists every check, tens of thousands of characters per wallet, so a ten-wallet batch was more than a model can take in from one tool result. By default the text is now a summary per wallet: the full address, profile ID, check set, expiry, the kids that signed it, the held / not held / not evaluated counts, and the checks held in each dimension. A wallet that was not signed is reported as not signed, to retry, never as a no. The complete signed profiles are returned unchanged as `structuredContent`, so a client that verifies them gets exactly what the API signed. A new optional `detail` input takes `"summary"` (the default) or `"full"`, which puts the complete signed profiles in the text as well. Choose it on the call that needs it: profiles cannot be fetched again, so a second call signs fresh profiles and is charged again. `detail` is not sent to the API and does not change the price of the call. The tool description also states that a pay-per-call (x402) payment covers every wallet in the request.
- **`insumer_list_tokens` says what the registry is:** a directory of the tokens and NFT collections listed in it. An attestation can check any token on a supported chain, and NFTs on EVM chains, Solana and XRPL, whether listed or not, so an empty result means nothing is listed under that filter, not that the token is unsupported.

## 1.18.0 (2026-10-06)

- **One credit balance.** `insumer_verify`, `insumer_acp_discount` and `insumer_ucp_discount` describe the single credit balance on the API key: a code that carries a discount costs one credit from the API key that owns the store, and a 0% result is free. A caller using another key is not charged; a caller using the owner key pays from its own balance. Stores on a licensed platform are covered by its license. Paid discount codes requested with a key other than the store's owner are subject to an hourly limit (429; the message says when to try again). `insumer_buy_merchant_credits` is kept for compatibility: a payment submitted there adds regular credits to the store owner's key at a flat 25 credits per $1, as the README states. `insumer_create_merchant` describes a new store as starting with no balance of its own; its `credits` field is the owner key's balance.
- **Core tools first.** `insumer_attest`, `insumer_compliance_templates`, `insumer_wallet_trust` and `insumer_batch_wallet_trust` are listed before `insumer_jwks` and `insumer_setup`, so a client that reads the tool list top down meets the core first. No tool changed name, inputs or behaviour.

## 1.17.1 (2026-10-05)

- **`insumer_configure_tokens` carries `alsoOn`** on partner tokens and the own token: the same token on up to 9 other networks (EVM chains and Solana; not the XRP Ledger, not a native coin). The store decides which deployments count as the same token. Each network's balance is read in that token's own decimals there, the balances are added exactly, and the tier is awarded once. A read that fails on any listed network refuses the whole check, never a partial total. When re-saving, carry each token's `alsoOn` through.

## 1.17.0 (2026-10-05)

- **Prove the wallet for a discount.** `insumer_verify`, `insumer_acp_discount` and `insumer_ucp_discount` take an optional `walletProof` (`{ message, signature }`): an EIP-4361 message signed by the EVM wallet, with URI `https://api.insumermodel.com/v1/merchants/{merchantId}`. The field's description carries the exact message to sign. A proven wallet gets the store's full discount with no daily limit, and the response says `walletProven: true`. Without a proof, the store's terms for unproven wallets apply, and `discountIfProven` shows what a proof would get. A proof that fails returns 401 and uses no credit. EVM wallets only; smart-contract wallets are not accepted yet.
- **Read the terms before calling.** `insumer_get_merchant`, `insumer_list_merchants` and `insumer_check_discount` describe `walletTerms`: what the store gives with and without proof. The free check's `totalDiscount` is what an unproven wallet gets.
- **`insumer_configure_settings` carries the store's terms for unproven wallets:** `maxUnprovenDiscount` (0 to 100, or null for the same as proven) and `maxDiscountsPerWalletPerDay` (1 to 100, or null).
- `insumer_validate_code` describes `walletProven` on a code.

## 1.16.2 (2026-10-05)

- **Tool descriptions say what `rpc_failure` means.** `insumer_attest`, `insumer_wallet_trust`, `insumer_verify`, `insumer_check_discount`, `insumer_acp_discount` and `insumer_ucp_discount` each state that an `rpc_failure` error (503) means a read did not complete, nothing was signed, and the call should be retried: it is never a "no". `insumer_batch_wallet_trust` states the same for its per-wallet error entries. `SKILL.md` carries the same guidance.
- **The merchant tools offer only the wallets the API reads.** `insumer_verify`, `insumer_check_discount`, `insumer_acp_discount` and `insumer_ucp_discount` take `wallet`, `solanaWallet` and `xrplWallet`. The Tron, Stellar and Sui wallet fields are removed from these four tools; the API never read them there. `insumer_attest` and the trust tools are unchanged.
- **`insumer_configure_nfts` carries `enabled` and `benefitType`.** A collection that was switched off stays off when its configuration is saved again, and a collection can be recognition only (`benefitType: "recognition"`, no discount).
- **`insumer_configure_tokens` carries `name` and `logo`** for each token, and `enabled` (true or false) for the own token.
- **Discounts are whole numbers.** The descriptions state that tier and NFT discounts are whole numbers from 1 to 50 and `discountCap` is a whole number from 1 to 100. The schemas already required integers.
- **XRPL `taxon` is an integer from 0 to 4294967295** on `insumer_attest` and `insumer_configure_nfts`.
- `insumer_attest` accepts a Sui coin type with type parameters, such as `0x2::coin::Coin<0x2::sui::SUI>`, up to 600 characters.

## 1.16.1 (2026-10-04)

- **XRPL currency codes are accepted in every form the API accepts.** `currency` on `insumer_attest` and on the merchant token tool takes a 3-character code, a token name of 1 to 20 printable ASCII characters, or a 40-character hex code, including codes that carry symbols. The description states that codes are case-sensitive and are sent exactly as issued.
- The README lists every tool that can answer `rpc_failure`, and describes how `insumer_batch_wallet_trust` reports a wallet whose reads did not complete.
- The MCP Registry description carries no tool count.

## 1.16.0 (2026-10-03)

- **Every tool declares an output schema.** The 27 tools share one schema describing the response envelope (`ok`, `data`, `meta`, `error`, plus `keys` for the JWKS and `message` for plain-text results), open to further fields so it stays true as endpoints grow.
- **Successful results carry `structuredContent`:** the same JSON the text content already held, parsed. The text content is unchanged, so clients that read it see no difference. Error results are unchanged.
- The `kyc` package keyword is removed. InsumerAPI reads wallet state; it is not an identity or KYC service.
- The HTTP runner answers any non-POST request with 405. A stateless server has no server-initiated stream to offer, and the SDK transport kept a GET event stream open indefinitely. (The hosted endpoint at api.insumermodel.com/mcp has had this since 2026-10-03.)

## 1.15.1 (2026-10-02)

- The MCP Registry entry lists the hosted endpoint (`https://api.insumermodel.com/mcp`, streamable HTTP) beside the npm package, and its description now says what the server does in the project's own words. No code changes.

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
