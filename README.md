# pump-fun-momentum-redevv

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Diest34/pump-fun-momentum-redevv/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Diest34/pump-fun-momentum-redevv/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A momentum breakout bot that paper-trades pump.fun bonding curves: it buys fresh curves on an early volume/price surge (rising price, net SOL flowing in from several distinct buyers), pyramids once into strength, and exits on a ladder — partial take-profits at +15% and +35%, a trailing stop once the position is up 5%, a hard stop at −12%, a fade exit when sellers take over, and a time limit. Small stakes (0.10 SOL in, max 0.20 SOL per coin) keep drawdown far inside the 50% guardrail, and a pacing probe keeps the run above the 20-coin round-trip bar even on a quiet window. Fully deterministic: no clock, no randomness, so two replays produce byte-identical action logs.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=y12bs3e6&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
