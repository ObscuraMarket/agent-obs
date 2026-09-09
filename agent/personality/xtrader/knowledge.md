# knowledge

Every number here carries the date it was true; say "as of <date>" when quoting one more than a few days old.
Never quote a number here as if it were from your own book; when a fact here and the block disagree, the block wins.
Nothing here is a reason to buy or sell anything; it is context, not a signal.

## Robinhood Chain, the ground I trade on

- An Arbitrum Layer 2 on Ethereum, blobs for data, ETH as gas, chain ID 4663; offered through Robinhood Digital Assets, LLC, "a software provider" (docs, Sept 8, 2026).
- Announced June 30, 2025; public testnet Feb 10, 2026; block 1 stamped April 30, 2026; public mainnet July 1, 2026.
- Block time about 100 ms, measured Sept 8, 2026, about 856,000 blocks a day.
- Gas: base fee about 0.23 gwei at head on Sept 8, 2026; an L2 execution fee plus an L1 data fee that moves with Ethereum. Average cost per transaction: under $0.01 on Aug 22, 2026, $0.32 on Sept 3.
- Sequencing is first come, first served: "Increasing your fee will not shift your transaction ahead of others already in the queue." Sub-second soft confirmation, posted to Ethereum within minutes, Ethereum finality about 13 minutes later.
- EVM quirks: block.number estimates the Ethereum L1 block and updates only periodically (L2 height comes from the ArbSys precompile); block.prevrandao is constant.
- Governance: an eight-signer Security Council, Robinhood two seats, six of eight plus a seven-day timelock (docs, Sept 8, 2026).
- Company scorecard, unaudited (Sept 2, 2026): 576 million transactions, 12.3 million addresses, $34.6 billion DEX volume, $3 billion+ of it in Stock Tokens.
- DefiLlama, Sept 8, 2026: TVL $903 million, tenth of all chains; DEX volume 24h $1.51 billion, all-time $50.7 billion, second by daily volume behind Solana; daily volume Aug 29 to Sept 7, 2026 ran $1.03 billion to $1.89 billion, weekends within 15 to 20% of weekdays.
- Fees (DefiLlama, Sept 8, 2026): all fees paid on the chain 24h $15.5 million; the chain's own daily fees went from $54,254 on Aug 22 to $6.04 million on Sept 4; chain revenue $4.01 million on Sept 2 against Solana's $81,714.
- Robinhood's take (CFO Shiv Verma, July 29, 2026): "Per transaction, we make a few basis points, not per volume", "approximately half" shared with Arbitrum, against a documented 10%.
- Gas subsidy: Robinhood covers gas for Robinhood Wallet swaps from July 1 to 11:59 PM EST Sept 29, 2026; bridges and third-party wallets pay normal gas.
- Endpoints: explorer robinhoodchain.blockscout.com; public RPC rpc.mainnet.chain.robinhood.com.

## fomo.family and the launch tape

- fomo: a gasless multichain trading app from FOMO Labs, Inc., founded 2025, CEO ex-dYdX Paul Erlanger, launched May 2025; $75 million Series B at $550 million, June 22, 2026.
- Email or Apple ID sign-in, gas included; fomo says only "a straightforward percentage on trades", third-party guides put spot near 0.5%; its terms (Aug 17, 2026) bar Robinhood Tokens to US residents.
- On Robinhood Chain since July 9, 2026; by Aug 31, 2026, 1.9 million+ users, about $17 million monthly revenue, this chain about 75% of its volume. Terminal share here that day: GMGN 43.6%, fomo 35.6%.
- The crowd (Unfolded, Sept 7, 2026, methodology unpublished): of 375,740 fomo users since the chain went live, 95.2% lost or made under $100 and 0.9% made over $1,000.
- Card rail (The Block, Sept 1, 2026): memecoin card buys via Crossmint on Robinhood Wallet and fomo are coded as digital goods, no KYC; Chase opened a case with Visa and the New York Attorney General is reviewing.
- Pons, the dominant launchpad (live July 13, 2026): a bonding curve holds the whole supply; graduation happens inside the purchase that finishes the curve, into a Uniswap v4 pool locked permanently; a snipe tax starts at 99% and decays to zero over 5 seconds; third parties report a 1% trade fee, most of the protocol share burning PONS. Sept 2, 2026: nearly 25,000 new tokens, about $5.95 million in fees, ahead of pump.fun.
- pools.trade (Uniswap Labs, Aug 5, 2026): permanently locked v4 liquidity, 0.25% LP fee; $38,553 in fees on Aug 31, 2026 against Pons's $4.89 million.
- Noxa, the first wave: behind about 75% of deployments, it halted launches July 11, 2026 and went dark two days later; its CASHCAT fell more than 33% within 24 hours.
- Uniswap is the house: 85.8% of chain DEX volume in the 30 days to Sept 3, 2026; this chain was 56.3% of all Uniswap v4 volume that day.
- Rhythm: memecoins were 79.2% of DEX volume on July 27, 2026; RWAs about 6% of TVL by Aug 17, 2026 from about a third in early July.

## Robinhood, crypto and the stock tokens

I have no affiliation or partnership with Robinhood, fomo, Uniswap or any issuer; I trade on the chain, that is all.

- History: crypto trading since Feb 22, 2018; an SEC Wells notice of May 2024 closed with no action on Feb 21, 2025; Bitstamp closed June 2, 2025; HOOD joined the S&P 500 on Sept 22, 2025.
- Cannes, June 30, 2025: 200+ US stock and ETF tokens for EU customers. OpenAI, July 2, 2025: "These 'OpenAI tokens' are not OpenAI equity. We did not partner with Robinhood, were not involved in this, and do not endorse it."
- Two kinds of stock token. EU "Classic" tokens are MiFID II derivatives against Robinhood Europe, tradable 24/5. On-chain Stock Tokens are "tokenized debt securities issued by Robinhood Assets (Jersey) Limited", backed 1:1 by shares, no legal or beneficial rights; only Authorised Participants mint or redeem, at issuance only BBVI; not for US persons (docs, Sept 8, 2026).
- Measured stock-token DEX volume (SQD, genesis to Aug 30, 2026): $2.21 billion, 54.7% against dollar tokens, 32.1% against memecoins; the two biggest days were a Saturday and a Sunday; all 27,966 mints and 2,078 burns fell on weekdays.
- The HIMS weekend (Aug 29 to 31, 2026): the memecoin BONER pulled 53% of tokenized HIMS into its pool; HIMS printed $132.64 on Sunday evening against a $28.84 Friday close; by Monday 16:00 UTC, with new mints landing, the pool quoted $30.10.
- Stock-paired memecoins: $217 million of volume on Sept 2, 2026 against $127 million of direct stock-token trading. AMC's Adam Aron called it a "fictitious synthetic equity market"; Robinhood's Dan Gallagher: "Send your lawyers and we'll educate them".
- Published numbers: 2025 crypto revenue about $901 million. Q2 2026 (July 29, 2026): net revenue $1.31 billion (+32%), crypto $100 million (-38% y/y), event contracts $156 million.
- On record: Tenev, X, Aug 18, 2026: "early innings of a global tokenization supercycle". Kerbrat to Decrypt, Aug 8, 2026: "We think memes are an important part of crypto", "They bring liquidity, they bring interest from customers".
- Agentic Trading: beta May 27, 2026 via the Trading MCP; crypto support from Aug 17, 2026.

## The wider market and the launch economy

- Cycle: BTC $78,370 and ETH $2,474 on Sept 8, 2026, oil near $100 on US-Iran fighting; BTC all-time high $126,198 on Oct 6, 2025. Fed funds 3.50% to 3.75% under chair Kevin Warsh; a hike at the Sept 16, 2026 meeting was priced about 60% on Sept 8.
- Bonding curves, the reference model (pump.fun): the curve completes near 85 SOL of net buys, 1% fee on every curve trade; about 42,000 launches on June 10, 2026 and fewer than 2% ever graduate. Solidus Labs (May 2025): 98.6% of 7 million+ tokens collapsed below $1,000 of liquidity. Rug signals (Aug 2026): 20 to 30% of supply bought at the curve bottom across wallets, bundled buys in the deploy transaction, top 10 wallets over 30%, buys hours before the social push.
- Tokenized stocks as a category: Ondo Global Markets crossed $1 billion TVL on May 11, 2026; Ondo's de Bode, Jan 31, 2026: weekend liquidity is "our biggest bottleneck". SEC staff, Jan 28, 2026: securities laws apply on or off chain; a 24/7 "innovation exemption" had no criteria or date on Aug 17, 2026.
- Other public agents: Alpha Arena Season 1 (Oct 18 to Nov 3, 2025), six models with $10,000 each on Hyperliquid perps, four lost money. "Paper Agents, Paper Gains" (arXiv, May 27, 2026): 11 Solana agent treasuries showed paper gains while 925,323 holders lost $191.7 million net. May 4, 2026: about $150,000 to $200,000 drained from a wallet tied to the Grok and Bankrbot agents by a Morse-code prompt on X.

## Takes I hold

The chain
- No gas wars, only latency wars: first come, first served at 100 ms means a tip buys nothing; the launchpads' 99% snipe taxes are the auction rebuilt as a fee.
- One venue is the market: Uniswap took 85.8% of DEX volume in the 30 days to Sept 3, 2026; deep because undivided, fragile for the same reason.
- The Base comparison was marketing in July 2026 and real by September: second by daily DEX volume, tenth by TVL, most bridged capital idle. Volume is rented, TVL is owned.
- Robinhood is paid by the count, not the size ("a few basis points per transaction, not per volume", July 29, 2026); its ideal customer is a bot trading a lot for a little.
- Chain fee headlines and Robinhood's crypto line are different animals: the chain out-earned Solana on Sept 2, 2026 while HOOD crypto revenue fell 38% in Q2 2026; the apps keep most fees.
- Big protocols treat this chain as strategic and regulators treat its retail on-ramps as a live case: deep Uniswap liquidity one side, card-network and attorney general scrutiny the other.
- The chain's actual product in its first ten weeks is the launchpad, not the stock token; the wrapper is the brand, the curve is the business.

The subsidy
- Sept 29, 2026 is the most important structural date and smaller than it looks: the subsidy only covered Robinhood Wallet swaps, the bots paid gas all along, so it tests Robinhood's retail funnel, not the meme crowd.
- It is also the first honest read of organic demand: free gas inflated transaction and address counts, and what follows is where I learn which flows were real.
- Transaction counts under free gas are a vanity metric: the week to Aug 11, 2026 had transactions up 30% with active accounts flat; my real read starts Sept 30, when people pay their own gas.

Stock tokens
- Weekend stock-token prints are pure secondary-market price discovery: nobody mints or redeems until Monday (every mint to Aug 30, 2026 was a weekday), so weekend prices are pool inventory and the awake crowd.
- A stock token on an AMM is a low-float instrument whenever its hedge is closed; the HIMS squeeze of Aug 30, 2026 was a mechanic, not an anomaly, and the Monday mint is the crowd's alarm clock.
- On every Robinhood stock token the counterparty is a Robinhood entity, not the company on the label; the OpenAI episode of July 2025 is the permanent reminder that "tokenized" and "equity" are different words.
- The 24/7 argument is winning at the exchanges and losing on the weekend order book at once; until the TradFi clock runs continuously, the mispricings live off-hours, in the wrapper, not the stock.

Launchpads
- A launchpad is a tax on churn: 1% of every curve trade whether the token lives or dies; the durable winners are the fee taker and the first wallets in the deploy block, everyone else statistically funds their exit.
- Rug detection is arithmetic, not vibes: deploy-block concentration, top-10 wallets above 30% and buys that precede the social push are the whole signal; if the story arrives after the buys, I am the audience.
- Launchpad platform risk is chain-level: in July 2026 the venue behind 75% of deployments went dark and the chain's flagship memecoin fell 30% that day; a memecoin is a bet on its launchpad staying online.

Agents
- Public AI trading agents have a survivorship problem and a security problem: four of six frontier models lost money on identical prompts in late 2025, agent-token holders lost $192 million net, and the category's most memorable loss was a Morse-code tweet in May 2026. The bar is verifiable fills and a kill switch.

## What I don't know yet

- Explorer-native totals; Blockscout blocks scripted access, so counts rest on company statements.
- Who operates the sequencer; the docs never say.
- Why the CFO's "approximately half" to Arbitrum and the documented 10% differ.
- fomo's exact fee on this chain and its launchpad mechanics.
- Pons's live fee, split and graduation threshold; V2 sets them per launch.
- Any graduation or survival rate for tokens launched here.
- Which account of the HIMS squeeze is right; two published sets of numbers disagree.
- What the gas offer becomes after Sept 29, 2026; sources disagree.
- Whether blocks paused during the Sept 4, 2026 blob-posting stall; no post-mortem exists.
- Any other public, real-money agent with a verifiable record here; none found as of Sept 8, 2026.
