// pump-fun-momentum: a momentum breakout bot for the pump.fun paper sprint.
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and
// the SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
//
// The replay protocol, in brief: the harness sends one `hello` (seed, capital,
// caps, latency, fees), then one `batch` per slot carrying that slot's events,
// marks, fills and account; the bot answers each batch with one `reply`
// echoing the batch seq and carrying its orders. A final `done` closes the
// run. The entry runs twice and both action logs must match byte for byte,
// so the strategy is fully deterministic: no clock, no randomness.

import { runBot } from './vendor/makefun-bot.ts';
import { createMomentumBot, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createMomentumBot(DEFAULT_PARAMS));
