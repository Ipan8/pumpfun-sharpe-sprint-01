[![Pump.fun Sharpe Sprint](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Ipan8/pumpfun-sharpe-sprint-01/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Ipan8/pumpfun-sharpe-sprint-01/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Steady Drip — pump.fun Sharpe scalper

A paper-trading bot for the 6-hour pump.fun forward replay in
[Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532).
Ranked by **hourly Sharpe ratio**, not by wildest PnL — so it trades like a
dripping tap, not a sniper.

## Strategy: dip-reversion scalper ("Steady Drip")

- **Many small round trips:** one fixed **0.03 SOL** stake per coin, no
  pyramiding, fast exits. Dozens of tiny outcomes per hour average into a
  smooth hourly return.
- **Buy the dip, never chase:** enter only a coin that already proved itself
  (price above its window start, net SOL inflow ≥ 0.3 SOL, ≥ 5 distinct buyers)
  AND is pulling back 1.5–15% from its recent high.
- **Tight exits:** take-profit **+12%**, stop-loss **−5%**, stall exit
  (flat ±1% after ~120 slots), flow-reversal exit (net flow < −0.3 SOL over
  20 slots), hard time exit (~360 slots). No trailing stop, no marrying bags.
- **Hourly pacing:** at most **8 new entries per hour** of block time, so
  trades land in every hour instead of bunching into hour one.
- **Wind-down:** in the last 45 minutes no new entries; exits tighten
  (TP +5%, SL −3%, max hold 120 slots) so the harness's forced flatten at
  the end of data cannot nuke the final hourly bucket. The wind-down starts
  at 5h15m of block time into the 6-hour window (windDownSecs 18900).

A behind-pace ladder loosens the dip filter step by step when the run trails
its coin target — the trend/flow/age filters are never dropped, and the bot
never buys a coin just to hit the 20-coin bar.

## Money facts

- Capital 10 SOL, max 5 open positions, latency 2 slots, max 16 orders/batch.
- Round trip costs ~3.2% of the 0.03 SOL stake (1.25% curve fees per side +
  ~0.000105 SOL tx fee per order), so TP +12% / SL −5% breaks even near a
  ~48% win rate; the edge must come from the entry filter.
- A buy needs the mint's real SOL reserve ≥ 3 SOL (1% max-order cap on a
  0.03 SOL stake); the 0.03 SOL stake clears the 0.01 SOL round-trip bar.
- Fully deterministic: no clock, no environment, no `Math.random` — the two
  grading executions produce byte-identical action logs.

## Dev scores (local grader, dev dataset, process driver)

- v1: Sharpe −0.466, PnL −0.0555 SOL, win rate 8.8%, 34 round trips.
- v2 (tighter entry): Sharpe −0.459, PnL −0.0490 SOL, win rate 7.1%, 28 coins.
- v3 (TP +12% / SL −5%, shipped): Sharpe −0.413, PnL −0.0722 SOL, win rate
  7.1%, 28 coins; stress median −0.03 SOL, 19 of 20 copies lost money.
- Guardrails met in all versions (≥ 20 coins, max drawdown ≤ 0.73%).
- Honest read: the dev window shows no edge yet — this entry is a free
  Sharpe lottery ticket on the fresh final window, not a proven winner.

## Files

- `main.ts` — entrypoint: thin adapter from the harness `BotState` to the
  pure strategy (`vendor/makefun-bot.ts` is the kit's SDK shim).
- `strategy.ts` — the pure "Steady Drip" strategy (no kit imports, no I/O).
- `vendor/makefun-bot.ts` — SDK shim copied from this competition's fresh kit.

## License

MIT — see [LICENSE](LICENSE).
