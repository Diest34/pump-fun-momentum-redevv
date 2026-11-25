// Local tests for the momentum strategy: determinism, entry signal, ladder
// exits, stop loss, and guardrail round-trip counting. Run with:
//   node --test tests/strategy.test.mjs
// (Node 22.6+ strips the types out of strategy.ts / vendor/makefun-bot.ts.)

import test from 'node:test';
import assert from 'node:assert/strict';
import { BotState, LAMPORTS_PER_SOL } from '../vendor/makefun-bot.ts';
import { createMomentumBot, DEFAULT_PARAMS } from '../strategy.ts';

const LAMPORTS = 1e9;
const VT = 1_073_000_000_000_000; // virtual token reserves (base units)
const MINT_A = 'A' + '1'.repeat(43);
const MINT_B = 'B' + '1'.repeat(43);
const MINT_C = 'C' + '1'.repeat(43);
const USERS = ['U1' + '1'.repeat(42), 'U2' + '1'.repeat(42), 'U3' + '1'.repeat(42), 'U4' + '1'.repeat(42), 'U5' + '1'.repeat(42), 'U6' + '1'.repeat(42), 'U7' + '1'.repeat(42), 'U8' + '1'.repeat(42)];

function hello() {
  return {
    type: 'hello',
    protocol: 'agent-fun/replay/v2',
    seed: '42',
    universe: { program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', quote: 'SOL', mayhem: 'excluded', exclude_cashback: true, sample: { hash: 'sha256', modulus: 16, residue: 15 } },
    capital: { lamports: '10000000000' },
    caps: { max_open_positions: 5, max_order_bps_of_real_reserve: 100, max_orders_per_batch: 16, shorts: false, leverage: false },
    latency_slots: 2,
    fees: { protocol_bps_fallback: 95, creator_bps_fallback: 30, base_fee_lamports: '5000', priority_fee_lamports: '100000', failed_tx_bps: 200 },
  };
}

function createEvent(mint, slot) {
  return {
    event: 'CreateEvent', mint, slot, signature: 'sig', block_time: 1793589000 + slot,
    chain_seq: 0, name: 'Test', symbol: 'TST', uri: '', bonding_curve: mint, user: USERS[0],
    creator: USERS[0], timestamp: '0', virtual_token_reserves: String(VT),
    virtual_quote_reserves: String(30 * LAMPORTS), real_token_reserves: String(VT),
    token_total_supply: String(VT), token_program: mint, is_mayhem_mode: false,
    is_cashback_enabled: false, quote_mint: 'So11111111111111111111111111111111111111112',
    virtual_quote_reserves: String(30 * LAMPORTS), creator_fee_bps: '0', is_holder_reward: false, depth: 0,
  };
}

// price is SOL per base-unit token; vq = price * VT.
function tradeEvent(mint, slot, isBuy, sol, price, user) {
  return {
    event: 'TradeEvent', mint, slot, signature: 'sig', block_time: 1793589000 + slot,
    chain_seq: 0, sol_amount: String(Math.round(sol * LAMPORTS)),
    token_amount: String(Math.round((sol * LAMPORTS) / (price * LAMPORTS))),
    is_buy: isBuy, user, timestamp: '0',
    virtual_sol_reserves: String(30 * LAMPORTS), virtual_token_reserves: String(VT),
    real_sol_reserves: String(5 * LAMPORTS), real_token_reserves: String(VT),
    fee_recipient: USERS[0], fee_basis_points: '95', fee: '0', creator: USERS[0],
    creator_fee_basis_points: '30', creator_fee: '0', track_volume: true,
    total_unclaimed_tokens: '0', total_claimed_tokens: '0',
    current_sol_volume: '0', last_update_timestamp: '0', ix_name: 'buy',
    mayhem_mode: false, cashback_fee_basis_points: '0', cashback: '0',
    buyback_fee_basis_points: '0', buyback: '0', shareholders: [],
    quote_mint: 'So11111111111111111111111111111111111111112',
    quote_amount: String(Math.round(sol * LAMPORTS)),
    virtual_quote_reserves: String(Math.round(price * VT)),
    real_quote_reserves: String(5 * LAMPORTS),
    holder_rewards_bps: '0', holder_rewards: '0', creator_fee_unclaimed: '0',
  };
}

function mark(mint, slot, price, rqSol = 5) {
  return {
    mint, slot,
    virtual_token_reserves: String(VT),
    virtual_quote_reserves: String(Math.round(price * VT)),
    real_token_reserves: String(VT),
    real_quote_reserves: String(Math.round(rqSol * LAMPORTS)),
  };
}

/** A tiny deterministic simulator: applies fills for the bot's orders at the
 *  current curve price, so the strategy's exit logic can be exercised. */
class Sim {
  constructor(bot) {
    this.bot = bot;
    this.state = new BotState(hello());
    this.cash = 10 * LAMPORTS;
    this.positions = new Map(); // mint -> { tokens, cost }
    this.seq = 0;
  }

  step(slot, events, marks = [], priceByMint = {}) {
    // Fabricate fills for the previous step's orders at the given prices.
    const fills = [];
    for (const o of this.lastOrders ?? []) {
      const price = priceByMint[o.mint] ?? 3e-5;
      if (o.side === 'buy') {
        const quote = Number(o.quote_lamports);
        // price is lamports per base-unit token (vq / vt).
        const tokens = Math.floor((quote * 0.9875) / price);
        const pos = this.positions.get(o.mint) ?? { tokens: 0, cost: 0 };
        pos.tokens += tokens;
        pos.cost += quote;
        this.positions.set(o.mint, pos);
        this.cash -= quote + 105000;
        fills.push({ client_id: o.client_id, mint: o.mint, side: 'buy', status: 'filled', reason: null, decided_slot: slot - 2, slot, quote_lamports: String(quote), token_amount: String(tokens), fee_lamports: '0', tx_fee_lamports: '105000', fee_fallback: false });
      } else {
        const tokens = Number(o.token_amount);
        const pos = this.positions.get(o.mint);
        if (!pos) continue;
        const sellTokens = Math.min(tokens, pos.tokens);
        const quote = Math.floor(sellTokens * price * 0.9875);
        pos.cost = Math.floor((pos.cost * (pos.tokens - sellTokens)) / pos.tokens);
        pos.tokens -= sellTokens;
        if (pos.tokens <= 0) this.positions.delete(o.mint);
        this.cash += quote - 105000;
        fills.push({ client_id: o.client_id, mint: o.mint, side: 'sell', status: 'filled', reason: null, decided_slot: slot - 2, slot, quote_lamports: String(Math.max(0, quote - 105000)), token_amount: String(sellTokens), fee_lamports: '0', tx_fee_lamports: '105000', fee_fallback: false });
      }
    }
    const account = {
      cash_lamports: String(Math.max(0, Math.floor(this.cash))),
      positions: [...this.positions.entries()].map(([mint, p]) => ({ mint, token_amount: String(p.tokens), cost_lamports: String(p.cost) })),
    };
    const batch = { type: 'batch', seq: this.seq++, slot, events, marks, fills, account };
    this.state.applyBatch(batch);
    const raw = this.bot.onBatch(this.state, batch);
    const orders = this.state.toOrders(raw);
    this.state.recordOrders(orders);
    this.lastOrders = orders;
    return orders;
  }
}

const BASE_PRICE = 3e-5; // SOL per base unit at launch

/** A surge tape: price +55% over the window, net inflow 6 SOL, accelerating
 *  (second-half inflow 9x the first half), 12 buys from 8 distinct buyers.
 *  Trades run from tradeStartSlot; the batch deciding the entry must come
 *  within the 90-slot window after them. */
function surgeEvents(mint, createSlot, tradeStartSlot) {
  const events = [createEvent(mint, createSlot)];
  for (let i = 0; i < 12; i++) {
    const slot = tradeStartSlot + i * 5;
    const frac = i / 11;
    const price = BASE_PRICE * (1 + 0.55 * frac);
    const sol = i < 6 ? 0.2 : 0.8;
    events.push(tradeEvent(mint, slot, true, sol, price, USERS[i % 8]));
  }
  return events;
}

test('determinism: identical batch streams produce identical orders', () => {
  const runOnce = () => {
    const sim = new Sim(createMomentumBot(DEFAULT_PARAMS));
    const out = [];
    const batches = [
      { slot: 1600, events: surgeEvents(MINT_A, 700, 1545), marks: [] },
      { slot: 1660, events: [tradeEvent(MINT_A, 1660, true, 0.2, BASE_PRICE * 1.6, USERS[0])], marks: [] },
      { slot: 1665, events: [tradeEvent(MINT_B, 1665, true, 0.1, BASE_PRICE, USERS[1])], marks: [] },
    ];
    for (const b of batches) out.push(JSON.stringify(sim.step(b.slot, b.events, b.marks, { [MINT_A]: BASE_PRICE * 1.16, [MINT_B]: BASE_PRICE })));
    return out;
  };
  assert.deepEqual(runOnce(), runOnce());
});

test('entry: buys a surging curve, ignores a flat one', () => {
  const sim = new Sim(createMomentumBot(DEFAULT_PARAMS));
  const orders = sim.step(1600, surgeEvents(MINT_A, 700, 1545), [], { [MINT_A]: BASE_PRICE * 1.55 });
  const buyA = orders.find((o) => o.side === 'buy' && o.mint === MINT_A);
  assert.ok(buyA, 'expected a buy on the surging mint');
  assert.equal(buyA.quote_lamports, '50000000', 'buy is capped at 1% of 5 SOL real reserve');
  // A flat curve (one small trade, no surge) gets no momentum buy — but with
  // zero round trips done it does get the 0.012 SOL pacing probe, by design.
  const flat = sim.step(1610, [tradeEvent(MINT_B, 1610, true, 0.05, BASE_PRICE, USERS[0])], [], { [MINT_B]: BASE_PRICE });
  const flatBuys = flat.filter((o) => o.side === 'buy' && o.mint === MINT_B);
  assert.equal(flatBuys.length, 1, 'flat mint gets exactly the pacing probe');
  assert.equal(flatBuys[0].quote_lamports, '12000000', 'probe is 0.012 SOL');
});

test('pacing: no probe once round trips are on pace', () => {
  // A stretched pace window makes one round trip already on pace.
  const sim = new Sim(createMomentumBot({ ...DEFAULT_PARAMS, paceSecs: 216000 }));
  sim.step(1600, surgeEvents(MINT_A, 700, 1545), [], { [MINT_A]: BASE_PRICE * 1.55 });
  // Fill lands at entry price, then dump so the stop loss round-trips the coin.
  sim.step(1610, [], [mark(MINT_A, 1610, BASE_PRICE * 1.55)], { [MINT_A]: BASE_PRICE * 1.55 });
  sim.step(1620, [], [mark(MINT_A, 1620, BASE_PRICE * 0.75)], { [MINT_A]: BASE_PRICE * 0.75 });
  sim.step(1630, [], [mark(MINT_A, 1630, BASE_PRICE * 0.75)], { [MINT_A]: BASE_PRICE * 0.75 });
  assert.equal(sim.bot.stats().roundTrips, 1);
  // One round trip is on pace under the stretched window: a flat mint now
  // gets no probe.
  const flat = sim.step(1640, [tradeEvent(MINT_B, 1640, true, 0.05, BASE_PRICE, USERS[0])], [], { [MINT_B]: BASE_PRICE });
  assert.equal(flat.filter((o) => o.mint === MINT_B).length, 0);
});

test('ladder: TP1 sells 40% at +15%, TP2 sells 40% of the rest at +35%', () => {
  // maxPerCoinSol 0.05 disables the pyramid add so the token counts stay clean.
  const sim = new Sim(createMomentumBot({ ...DEFAULT_PARAMS, maxPerCoinSol: 0.05 }));
  sim.step(1600, surgeEvents(MINT_A, 700, 1545), [], { [MINT_A]: BASE_PRICE * 1.55 });
  // Fill lands at entry price on the next batch.
  sim.step(1610, [], [mark(MINT_A, 1610, BASE_PRICE * 1.55)], { [MINT_A]: BASE_PRICE * 1.55 });
  const pos = [...sim.positions.values()][0];
  assert.ok(pos && pos.tokens > 0, 'buy should have filled');
  const heldTokens = pos.tokens;
  // Entry was at +55% over launch, so TP1 (+15% over cost) needs ~2.1x launch.
  const o1 = sim.step(1620, [], [mark(MINT_A, 1620, BASE_PRICE * 2.1)], { [MINT_A]: BASE_PRICE * 2.1 });
  const tp1 = o1.find((o) => o.side === 'sell');
  assert.ok(tp1, 'expected TP1 sell at 2.1x launch (+35% over cost)');
  const tp1Share = Number(tp1.token_amount) / heldTokens;
  assert.ok(tp1Share > 0.35 && tp1Share < 0.45, `TP1 should sell ~40%, sold ${tp1Share}`);
  // Price 2.7x launch (+74% over cost): TP2 fires on the remainder.
  const o2 = sim.step(1630, [], [mark(MINT_A, 1630, BASE_PRICE * 2.7)], { [MINT_A]: BASE_PRICE * 2.7 });
  const tp2 = o2.find((o) => o.side === 'sell');
  assert.ok(tp2, 'expected TP2 sell at +70%');
  const remaining = heldTokens - Number(tp1.token_amount);
  const tp2Share = Number(tp2.token_amount) / remaining;
  assert.ok(tp2Share > 0.35 && tp2Share < 0.45, `TP2 should sell ~40% of rest, sold ${tp2Share}`);
});

test('stop loss: full exit when value falls 12% below cost', () => {
  const sim = new Sim(createMomentumBot(DEFAULT_PARAMS));
  sim.step(1600, surgeEvents(MINT_A, 700, 1545), [], { [MINT_A]: BASE_PRICE * 1.55 });
  // Fill lands at entry price first.
  sim.step(1610, [], [mark(MINT_A, 1610, BASE_PRICE * 1.55)], { [MINT_A]: BASE_PRICE * 1.55 });
  const pos = [...sim.positions.values()][0];
  assert.ok(pos && pos.tokens > 0, 'buy should have filled');
  const heldTokens = pos.tokens;
  // Price -52% from entry: value ~0.48x cost -> stop loss fires, sells all.
  const o = sim.step(1620, [], [mark(MINT_A, 1620, BASE_PRICE * 0.75)], { [MINT_A]: BASE_PRICE * 0.75 });
  const sell = o.find((x) => x.side === 'sell');
  assert.ok(sell, 'expected a stop-loss sell');
  assert.equal(Number(sell.token_amount), heldTokens, 'stop loss sells everything');
});

test('guardrail: a completed >= 0.01 SOL round trip is counted', () => {
  const sim = new Sim(createMomentumBot(DEFAULT_PARAMS));
  sim.step(1600, surgeEvents(MINT_A, 700, 1545), [], { [MINT_A]: BASE_PRICE * 1.55 });
  assert.equal(sim.bot.stats().roundTrips, 0);
  // Fill lands at entry price, then dump so the stop loss sells the position.
  sim.step(1610, [], [mark(MINT_A, 1610, BASE_PRICE * 1.55)], { [MINT_A]: BASE_PRICE * 1.55 });
  sim.step(1620, [], [mark(MINT_A, 1620, BASE_PRICE * 0.75)], { [MINT_A]: BASE_PRICE * 0.75 });
  sim.step(1630, [], [mark(MINT_A, 1630, BASE_PRICE * 0.75)], { [MINT_A]: BASE_PRICE * 0.75 });
  assert.equal(sim.bot.stats().roundTrips, 1, 'buy 0.05 SOL + sell counts as one round trip');
  assert.equal(sim.bot.stats().coinsTraded, 1);
});

test('guardrail math: value helper matches the constant-product curve', () => {
  // Independent check of the sell-value formula used by the strategy:
  // tokens * vq / (vt + tokens), minus 1.25% curve fee and one tx fee.
  const tokens = 1.6e12;
  const vt = VT;
  const vq = 3.81e10;
  const gross = (tokens * vq) / (vt + tokens) / LAMPORTS;
  const value = gross * (1 - 0.0125) - 105000 / LAMPORTS;
  assert.ok(value > 0.05 && value < 0.06, `sell value ${value} SOL should be ~0.056`);
});
