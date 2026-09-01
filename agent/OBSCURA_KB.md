# Obscura: what OBS knows

Background knowledge so OBS can speak about Obscura accurately. Every fact
below was read from obscura.market (the app, its docs, roadmap, rewards and
privacy pages) and from Robinhood Chain on 2026-09-01. Facts only. Roadmap
items are targets, in Obscura's own words: "Quarters are targets, not
promises." No em dashes.

## What Obscura is

Private liquidity infrastructure. A non-custodial exchange aggregator: you
pick a token to send and a token to receive, enter the receiving wallet
address, and Obscura compares routes across centralized and decentralized
venues, shields the order intent before it reaches a public book, then builds
and tracks the swap and settles straight to your own wallet. No account, no
KYC, no custody handover: Obscura never holds your balance. In its own words:
"the easiest data to protect is data that is never collected."

Site: obscura.market (obscuracex.com serves the same app). X: @ObscuraCEX.
App pages: /exchange (swap, quotes, order tracking by order id), /rewards,
/rwa, /yield, /cards, /referral, /roadmap, /docs, /privacy.

## How a swap works, in the app's own steps

1. Choose the token and amount to send and the token to receive. The output
   is estimated from live market rates.
2. Enter the receiving wallet address. Obscura matches the network to it.
3. Send the exact amount to the generated deposit address. The deposit goes
   straight into the route; Obscura never holds the funds.
4. Track the order on its progress page. Every order has a trackable status
   and an on-chain settlement transaction you can verify yourself.
5. Typically a few minutes, depending on confirmations and the chosen route.

Every quote comes from live venues. The automatic choice can be overridden
and any partner picked by hand.

## Routing venues the app names

- Exchange routes: Binance, Bybit, KuCoin, MEXC, Huobi, CEX Pool, StealthEX.
- Privacy routes: Houdini Swap, Anyswap, Husher, Relay.
- Pool route: SwapSpace. Also NEAR Intents.
- Cross-chain settlement uses Relay (api.relay.link).
- Chains the app names: Ethereum, BSC, Base, zkSync, Arbitrum, Optimism,
  Polygon, Avalanche, Linea, Robinhood Chain (chain id 4663), Bitcoin, Tron;
  asset lists also carry Solana, Litecoin, Monero, TON and Sui.

## Dark Orders and shielded intent

The pitch, in Obscura's words: on a normal DEX or aggregator a swap hits a
public mempool or is visible to operators. Obscura shields the order: "The
winning solver executes across the chosen venue(s). Route and size stay
private: no frontrunning, no sandwiching, no strategy leakage." Dark Orders
are a launch-season roadmap item; describe them as what the product is built
to do, never as a number you measured.

## Swap-to-earn: cashback paid in tokenized stocks

Every private swap pays back a share of its fees as cashback in tokenized
stocks on Robinhood Chain (AAPL, TSLA, NVDA and more). The rate scales with
rolling 30-day volume through Obscura: more volume, higher rate. Payouts land
monthly, settled to the user's own wallet, no opt-in, no claim forms. Users
pick a single payout stock or spread rewards across a diversified mix. The
/rewards page is the dashboard: swaps, volume, cashback, and a Blockscout link
for every reward transaction. Obscura calls this the first swap-to-earn
mechanism that pays in real-world assets. The public rewards API
(api.obscura.market/rewards/{wallet}) reports swaps, volumeUsd, rewardsUsd,
paidUsd and flyingUsd per wallet.

Referrals (waitlist): a cut of every referred swap, paid in the same
tokenized-stock cashback, uncapped, based on the volume they bring.

**Programme status, read carefully.** The rewards page describes cashback in
the present tense and the rewards API answers, but the onboarding copy says
a first swap's volume "starts counting toward stock cashback the moment the
programme opens." So: describe the mechanic freely, never claim that a
payout has landed for anyone, and never say the programme is open unless a
live read shows a reward transaction. "The mechanic" is a fact; "it paid out"
is not measured.

## The $OBS token, verified on chain 2026-09-01

Contract on Robinhood Chain: 0xfe242d1da8fd04f6a1f80b6d3d807b02e062ad4e.
Name "Obscura", symbol OBS, 18 decimals, total supply 1,000,000,000. Holder
count and price move; OBS reads them live (src/obscura/reads.ts) and never
quotes a stale one. OBS points people at the site to verify the contract
rather than pasting the address. Where it trades, and how thin that market
is, is in ROBINHOOD_CHAIN_KB.md and obs-chain.json.

Utility the app describes:
- Fee tier discounts that scale with $OBS balance ("Hold $OBS and trade on a
  reduced fee tier"; the app reads the balance on Robinhood Chain and shows
  the live tier).
- Reward boost: holding at least 0.5% of supply lifts cashback from 0.25% to
  0.5% automatically.
- Roadmap: staking to lock tiers and boost rewards; holders voting on
  listings, fee parameters and treasury spend; a share of protocol fees
  buying $OBS on the market and burning it monthly; $OBS-gated API keys;
  cards that earn $OBS back on spend. All targets, none live.

## Obscura AI

An assistant inside the app. Tell it what you want in plain language ("swap 1
ETH for USDC") and it builds the transaction, then drops you on the live
order page. It never asks for a private key or seed phrase, only the public
receiving address.

## The roadmap as published (Q3 2026 to Q2 2027)

Launch season: the platform, Dark Orders, mobile and $OBS utility. Then a
$50,000 competition across volume and PnL boards, an order-splitting engine
across exchange and DEX liquidity, tokenized stocks open to the public, the
public quote and routing API, the assistant trading with you, a $100,000
championship, native iOS and Android apps, an institutional dark pool, and
cards. Waitlists are open for yield (staking and LP), RWA trading, cards and
referrals; $OBS holders get access first.

## Privacy, in the policy's words

No name, email, phone number, government ID or precise location is collected,
and no personal data is sold. Preferences and recent swap history stay in the
browser's local storage. To quote and execute a swap the addresses and
amounts are processed by Obscura's infrastructure and the third-party
providers that fulfil the trade, and order records may be stored for lookup
by order id.

## Disclaimers Obscura itself makes

Crypto assets are volatile and transactions are irreversible. Obscura is a
non-custodial routing interface and does not provide investment advice.
Verify the receiving address and network before every trade.

## What OBS does not know (say "not measured" rather than guess)

The fee schedule and the full tier table, platform volumes, user counts, the
team, audit status, the API specification (a roadmap item), and any number
that is not on the page or on chain at the time of posting.
