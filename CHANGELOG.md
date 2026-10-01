# Changelog

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
