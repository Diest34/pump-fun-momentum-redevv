// Momentum breakout bot for the pump.fun paper sprint (agent-fun/replay/v2).
//
// Idea: fresh pump.fun curves that surge early — rising price, net SOL flowing
// in from several distinct buyers — keep running for a while. Buy the surge,
// then exit on a ladder: partial take-profits at +25% and +60%, a trailing
// stop once the position is up 10%, a hard stop at -20%, a fade exit when
// sellers take over, and a time limit. Stakes are small (0.10 SOL in, one
// 0.10 SOL add) so a full round of losers costs ~2% of capital, far inside
// the 50% drawdown guardrail. A pacing probe keeps the run above the
// guardrail bar (a >= 0.01 SOL round trip on each of at least 20 coins) even
// on a quiet window: when completed round trips lag the pace, the bot opens
// tiny 0.012 SOL round trips on the most recently traded liquid curves.
//
// Deterministic by construction: no clock, no environment, no randomness;
// every iteration is over insertion-ordered maps fed by the batch stream, so
// two executions of the same replay produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface MomentumParams {
  /** Entry window in slots. */
  window: number;
  /** Price rise over the window required to enter (fraction, e.g. 0.08 = +8%). */
  minUp: number;
  /** Price rise over the window above which the move is already over. */
  maxUp: number;
  /** Net buy SOL (buys minus sells) over the window required to enter. */
  minNetSol: number;
  /** Buy trades in the window required to enter. */
  minBuys: number;
  /** Distinct buying wallets in the window required to enter. */
  minBuyers: number;
  /** Price now must be at least this share of the window high. */
  nearHigh: number;
  /** Real SOL reserve bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** First buy of a position (SOL). */
  firstSol: number;
  /** One add-on buy (SOL). */
  addSol: number;
  /** Most SOL in one position. */
  maxPerCoinSol: number;
  /** Smallest buy worth sending (SOL); matches the guardrail round-trip floor. */
  minBuySol: number;
  /** Price must be this much above the last buy's price before adding. */
  addStep: number;
  /** Net SOL over the entry window required to add. */
  addNetSol: number;
  /** Newer-half net inflow must be at least this multiple of the older half's
   *  (acceleration); 0 = off. */
  accel: number;
  /** Slippage on buys (bps); sells always go out wide open. */
  buySlipBps: number;
  /** Exit: sell everything when value falls this far below cost. */
  stopLoss: number;
  /** Trailing stop arms once peak value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Trailing stop: sell everything when value falls this far below peak. */
  trail: number;
  /** First take-profit: value >= cost * (1 + tp1) -> sell tp1Share of tokens. */
  tp1: number;
  tp1Share: number;
  /** Second take-profit: value >= cost * (1 + tp2) -> sell tp2Share of the rest. */
  tp2: number;
  tp2Share: number;
  /** Exit when net SOL over fadeWindow slots falls below -fadeNetSol. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit after this many slots held (unless up at least holdIfUp). */
  maxHold: number;
  holdIfUp: number;
  /** Slots to wait after an exit before the same curve may be entered again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Guardrail pacing: target coins with a completed round trip. */
  targetCoins: number;
  /** Window the pace is measured over (seconds of block time). */
  paceSecs: number;
  /** Size of a pacing probe round trip (SOL). */
  probeSol: number;
  /** Most probes open at once. */
  maxProbes: number;
}

export const DEFAULT_PARAMS: MomentumParams = {
  window: 90,
  minUp: 0.5,
  maxUp: 0.8,
  minNetSol: 5,
  minBuys: 10,
  minBuyers: 8,
  nearHigh: 0.97,
  minRqSol: 2,
  maxRqSol: 25,
  minAge: 600,
  firstSol: 0.1,
  addSol: 0.1,
  maxPerCoinSol: 0.2,
  minBuySol: 0.01,
  addStep: 0.25,
  addNetSol: 0.2,
  accel: 3,
  buySlipBps: 1500,
  stopLoss: 0.12,
  trailArm: 0.05,
  trail: 0.2,
  tp1: 0.15,
  tp1Share: 0.4,
  tp2: 0.35,
  tp2Share: 0.4,
  fadeWindow: 30,
  fadeNetSol: 0.5,
  maxHold: 1500,
  holdIfUp: 0.5,
  cooldown: 300,
  maxEntries: 2,
  targetCoins: 25,
  paceSecs: 21600,
  probeSol: 0.012,
  maxProbes: 2,
};

const LAMPORTS = 1e9;
/** Curve fee taken on a sell (protocol + creator, ~1.25%). */
const CURVE_FEE = 0.0125;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  /** Best value/cost ratio seen (a ratio, so partial sales don't stale it). */
  peakRatio: number;
  /** SOL sent in buys for this position. */
  invested: number;
  /** A buy of this position has filled. */
  filled: boolean;
  /** Price at which the last buy was decided. */
  lastAddPrice: number;
  tp1Done: boolean;
  tp2Done: boolean;
  exiting: boolean;
}

export interface BotStats {
  batches: number;
  myFills: number;
  roundTrips: number;
  coinsTraded: number;
  buysSent: number;
  sellsSent: number;
}

export interface MomentumBot extends Bot {
  stats(): BotStats;
}

export function createMomentumBot(p: MomentumParams = DEFAULT_PARAMS): MomentumBot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Pacing probes in flight, by mint. */
  const probes = new Map<Pubkey, true>();
  /** Mints a probe already round-tripped on: never probe the same coin twice. */
  const probed = new Set<Pubkey>();
  /** Filled buy SOL per mint (own fills only). */
  const buySol = new Map<Pubkey, number>();
  /** Filled sell SOL per mint (own fills only). */
  const sellSol = new Map<Pubkey, number>();
  const roundTripCoins = new Set<Pubkey>();
  let myFills = 0;
  let buysSent = 0;
  let sellsSent = 0;
  let batches = 0;
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.window, p.fadeWindow) + 10;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Price of a mint in SOL per token, from its latest reserves. */
  const priceOf = (state: BotState, mint: Pubkey): number => {
    const c = state.curves.get(mint);
    if (c === undefined) return 0;
    const vt = Number(c.virtual_token_reserves);
    if (vt <= 0) return 0;
    return Number(c.virtual_quote_reserves) / vt;
  };

  /** What the held tokens would fetch now (SOL), curve fee and one tx fee off. */
  const sellValue = (state: BotState, mint: Pubkey, tokens: bigint): number => {
    const c = state.curves.get(mint);
    if (c === undefined) return 0;
    const vt = Number(c.virtual_token_reserves);
    const vq = Number(c.virtual_quote_reserves);
    const n = Number(tokens);
    if (vt <= 0 || n <= 0) return 0;
    const gross = (n * vq) / (vt + n) / LAMPORTS;
    return gross * (1 - CURVE_FEE) - Number(state.txFeeLamports()) / LAMPORTS;
  };

  /** Net recorded SOL (buys minus sells) on a tape over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** The entry signal: an early surge with broad buying behind it. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    const from = now - p.window;
    const mid = now - p.window / 2;
    let buySolW = 0;
    let sellSolW = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const buyers = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySolW += tr.sol;
        buys++;
        buyers.set(tr.user, (buyers.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSolW += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || buyers.size < p.minBuyers) return false;
    if (buySolW - sellSolW < p.minNetSol) return false;
    if (p.accel > 0 && (netNew <= 0 || netNew < p.accel * netOld)) return false;
    if (startPrice <= 0 || last <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.minUp || up > p.maxUp) return false;
    if (last < high * p.nearHigh) return false;
    return true;
  };

  const bot: MomentumBot = {
    stats(): BotStats {
      return {
        batches,
        myFills,
        roundTrips: roundTripCoins.size,
        coinsTraded: buySol.size,
        buysSent,
        sellsSent,
      };
    },

    onBatch(state: BotState, batch: Batch): OrderInput[] {
      batches++;
      const now = batch.slot;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS;
      const traded = new Set<Pubkey>();

      for (const f of batch.fills) {
        if (f.status !== 'filled' || f.client_id.startsWith('_')) continue;
        myFills++;
        const sol = Number(f.quote_lamports) / LAMPORTS;
        if (f.side === 'buy') {
          buySol.set(f.mint, (buySol.get(f.mint) ?? 0) + sol);
        } else {
          sellSol.set(f.mint, (sellSol.get(f.mint) ?? 0) + sol);
        }
        if ((buySol.get(f.mint) ?? 0) >= p.minBuySol && (sellSol.get(f.mint) ?? 0) > 0) {
          roundTripCoins.add(f.mint);
        }
      }

      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(e.sol_amount) / LAMPORTS,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const pendingByMint = new Map<Pubkey, { buy: boolean; sell: boolean }>();
      for (const po of state.pending.values()) {
        const rec = pendingByMint.get(po.order.mint) ?? { buy: false, sell: false };
        if (po.order.side === 'buy') rec.buy = true;
        else rec.sell = true;
        pendingByMint.set(po.order.mint, rec);
      }
      const pend = (mint: Pubkey): { buy: boolean; sell: boolean } =>
        pendingByMint.get(mint) ?? { buy: false, sell: false };

      // ---- Exits first: laddered take-profits, trailing stop, stop loss, fade, time.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pend(mint).buy && !pend(mint).sell) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const tokens = BigInt(pos.token_amount);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        const value = sellValue(state, mint, tokens);
        if (cost <= 0) continue;
        const ratio = value / cost;
        if (ratio > h.peakRatio) h.peakRatio = ratio;

        let fullExit = false;
        if (value < cost * (1 - p.stopLoss)) fullExit = true;
        if (!fullExit && h.peakRatio >= 1 + p.trailArm && ratio < h.peakRatio * (1 - p.trail)) fullExit = true;
        if (!fullExit && flow(tapeOf(mint), now, p.fadeWindow) < -p.fadeNetSol) fullExit = true;
        if (!fullExit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) fullExit = true;

        let sellTokens: bigint | null = null;
        if (fullExit) {
          sellTokens = tokens;
        } else if (!h.tp2Done && h.tp1Done && value >= cost * (1 + p.tp2)) {
          sellTokens = (tokens * BigInt(Math.round(p.tp2Share * 1000))) / 1000n;
          h.tp2Done = true;
        } else if (!h.tp1Done && value >= cost * (1 + p.tp1)) {
          sellTokens = (tokens * BigInt(Math.round(p.tp1Share * 1000))) / 1000n;
          h.tp1Done = true;
        }
        if (sellTokens === null || sellTokens <= 0n) continue;
        if (pend(mint).sell) continue;
        if (orders.length >= cap) break;
        if (fullExit) h.exiting = true;
        orders.push({ side: 'sell', mint, token_amount: sellTokens, max_slippage_bps: 10_000 });
        sellsSent++;
      }

      // ---- Pacing probes: sell the whole probe as soon as its buy has landed.
      for (const mint of [...probes.keys()]) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pend(mint).buy && !pend(mint).sell) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pend(mint).buy || pend(mint).sell) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        sellsSent++;
        probes.delete(mint);
        probed.add(mint);
      }

      // ---- Entries and one add per position, in this batch's trade order.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pend(mint).buy || pend(mint).sell || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const price = priceOf(state, mint);
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (!entrySignal(t, now, rqSol)) continue;
          want = p.firstSol;
        } else {
          // Pyramid into strength only: up from the last buy, inflow still positive.
          if (h.exiting || !h.filled || h.invested >= p.maxPerCoinSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (flow(t, now, p.window) < p.addNetSol) continue;
          if (rqSol > p.maxRqSol) continue;
          want = Math.min(p.addSol, p.maxPerCoinSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want);
        if (amount > free - txSol) amount = free - txSol;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        buysSent++;
        free -= amount + txSol;
        if (h === undefined) {
          held.set(mint, {
            opened: now,
            peakRatio: 0,
            invested: amount,
            filled: false,
            lastAddPrice: price,
            tp1Done: false,
            tp2Done: false,
            exiting: false,
          });
          t.entries++;
          slotsLeft--;
        } else {
          h.invested += amount;
          h.lastAddPrice = price;
        }
      }

      // ---- Guardrail pacing: open a probe when round trips lag the pace.
      if (
        probes.size < p.maxProbes &&
        slotsLeft > 0 &&
        firstTime !== null &&
        lastTime !== null &&
        lastTime > firstTime
      ) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        if (roundTripCoins.size < Math.ceil(p.targetCoins * pace)) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || probed.has(mint)) continue;
            if (pend(mint).buy || pend(mint).sell || state.positions.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * txSol) break;
            orders.push({
              side: 'buy',
              mint,
              quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)),
              max_slippage_bps: p.buySlipBps,
            });
            buysSent++;
            probes.set(mint, true);
            free -= p.probeSol + txSol;
            slotsLeft--;
          }
        }
      }

      return orders;
    },
  };

  return bot;
}
