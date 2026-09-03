// The AI opponent's decision engine. Called once per bot "step" (see
// matchRoom.js's alarm()-driven bot loop) and returns a single action for
// the caller to run through the real rules.js functions — this file never
// mutates `game` itself, so the exact same validate+execute path a human's
// WebSocket message goes through is what actually resolves every bot move.
//
// Hidden-information contract: board state (units, HP, mana, keywords) is
// public to both players, so reading it straight off `game` is fine. What is
// NOT fine — and this file must never do — is reading
// `game.players[opponentOf(botOwner)].hand` or `.deck`. Those two fields are
// the only ones viewFor() redacts for a real client, and the bot is held to
// the same rule. Every helper below takes only the bot's own hand and public
// board state as input.
import { opponentOf, getLegalAttackTargets } from './rules.js';

const RANGED_KEYWORDS = ['volley', 'siege'];

function isRanged(unit) {
  return unit.keywords.some((k) => RANGED_KEYWORDS.includes(k));
}

function allUnitsWithLoc(player) {
  const out = [];
  for (const lane of ['vanguard', 'rearguard']) {
    player.board[lane].forEach((u, slot) => {
      if (u) out.push({ unit: u, lane, slot });
    });
  }
  return out;
}

function firstEmptySlot(player, preferredLane) {
  const lanes = preferredLane === 'rearguard' ? ['rearguard', 'vanguard'] : ['vanguard', 'rearguard'];
  for (const lane of lanes) {
    const idx = player.board[lane].findIndex((s) => !s);
    if (idx !== -1) return { lane, slotIndex: idx };
  }
  return null;
}

// Difficulty only ever changes decision quality — every tier sees the same
// public game state. Easy mixes in real randomness and skips lethal-checking;
// Hard tightens the scoring and always takes a kill when the math is there.
const DIFFICULTY_PRESETS = {
  easy: { randomness: 0.45, checkLethal: false, respectBadTrades: false },
  normal: { randomness: 0.15, checkLethal: true, respectBadTrades: true },
  hard: { randomness: 0.03, checkLethal: true, respectBadTrades: true },
};

function presetFor(difficulty) {
  return DIFFICULTY_PRESETS[difficulty] || DIFFICULTY_PRESETS.normal;
}

// Picks from a list of {action, score} candidates. Higher score is better;
// `randomness` (0-1) is the chance of ignoring the top pick in favor of a
// weighted-random one instead, which is what makes Easy look human-fallible
// without ever letting it see anything a real player couldn't.
function pickWeighted(candidates, randomness) {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  if (Math.random() >= randomness) return sorted[0].action;
  const idx = Math.floor(Math.random() * sorted.length);
  return sorted[idx].action;
}

function chooseSpellTarget(game, owner, card) {
  const kind = card.target || 'none';
  const you = game.players[owner];
  const opp = game.players[opponentOf(owner)];
  const maxPower = card.effect?.maxTargetPower;
  const withinLimit = (u) => maxPower === undefined || u.power <= maxPower;

  if (kind === 'none') return { target: undefined, ok: true };

  if (kind === 'enemy_unit') {
    const pool = allUnitsWithLoc(opp).filter((e) => withinLimit(e.unit));
    if (!pool.length) return { ok: false };
    pool.sort((a, b) => b.unit.power - a.unit.power); // remove the biggest threat
    return { target: { lane: pool[0].lane, slot: pool[0].slot }, ok: true };
  }
  if (kind === 'ally_unit') {
    const pool = allUnitsWithLoc(you).filter((e) => withinLimit(e.unit));
    if (!pool.length) return { ok: false };
    pool.sort((a, b) => a.unit.defense / a.unit.maxDefense - b.unit.defense / b.unit.maxDefense); // heal/buff the most hurt ally
    return { target: { lane: pool[0].lane, slot: pool[0].slot }, ok: true };
  }
  if (kind === 'empty_ally_slot') {
    const slot = firstEmptySlot(you);
    if (!slot) return { ok: false };
    return { target: { lane: slot.lane, slot: slot.slotIndex }, ok: true };
  }
  if (kind === 'ally_row') {
    const vCount = you.board.vanguard.filter(Boolean).length;
    const rCount = you.board.rearguard.filter(Boolean).length;
    if (vCount === 0 && rCount === 0) return { ok: false };
    return { target: { lane: rCount > vCount ? 'rearguard' : 'vanguard' }, ok: true };
  }
  if (kind === 'multi_enemy_unit' || kind === 'multi_enemy_unit_distinct') {
    const eff = card.effect;
    const need = kind === 'multi_enemy_unit' ? eff.total : eff.count;
    const distinctMax = kind === 'multi_enemy_unit' ? eff.maxTargets : need;
    const pool = allUnitsWithLoc(opp).sort((a, b) => a.unit.defense - b.unit.defense);
    if (!pool.length) return { ok: false };
    const hits = [];
    for (let i = 0; i < need; i++) {
      const pick = pool[Math.min(i, distinctMax - 1, pool.length - 1)];
      hits.push({ lane: pick.lane, slot: pick.slot });
    }
    return { target: { hits }, ok: true };
  }
  return { ok: false };
}

function scoreDeploymentCard(game, owner, card, preset) {
  const you = game.players[owner];
  if (card.type === 'spell') {
    const { target, ok } = chooseSpellTarget(game, owner, card);
    if (!ok) return null;
    // Removal/buffs are worth roughly what they'd cost to fight for on board.
    const score = 4 + card.cost * 0.5;
    return { action: { type: 'play_card', cardInstanceId: card.instanceId, spellTarget: target }, score };
  }
  const preferredLane = isRanged(card) ? 'rearguard' : 'vanguard';
  const slot = firstEmptySlot(you, preferredLane);
  if (!slot) return null;
  // Mana efficiency (use as much of the turn's mana as reasonable) plus raw
  // stats — a simple, honest "biggest legal play" heuristic, not a lookahead.
  const statScore = (card.power || 0) + (card.defense || 0) * 0.75;
  const score = statScore + card.cost * 0.3;
  return {
    action: { type: 'play_card', cardInstanceId: card.instanceId, lane: slot.lane, slotIndex: slot.slotIndex },
    score,
  };
}

function decideDeploymentAction(game, owner, preset) {
  const you = game.players[owner];
  const affordable = you.hand.filter((c) => c.cost <= you.mana);
  const candidates = [];
  for (const card of affordable) {
    const scored = scoreDeploymentCard(game, owner, card, preset);
    if (scored) candidates.push(scored);
  }
  if (candidates.length === 0) return { type: 'move_to_combat' };
  // Always leave room to still move to combat this "turn" of decisions —
  // treat it as a low-scoring candidate so a genuinely bad hand still
  // eventually progresses instead of forcing a bad play.
  candidates.push({ action: { type: 'move_to_combat' }, score: preset.respectBadTrades ? 1 : 0.5 });
  return pickWeighted(candidates, preset.randomness);
}

function estimatePower(unit) {
  return (unit.power || 0) + (unit.tempPowerBonus || 0);
}

function scoreAttack(game, owner, attacker, loc, target, preset) {
  const opp = game.players[opponentOf(owner)];
  const atkPower = estimatePower(attacker);
  if (target.type === 'castle') {
    return { action: { type: 'attack', attackerLane: loc.lane, attackerSlot: loc.slot, targetLane: 'commander' }, score: 3 };
  }
  const targetUnit = opp.board[target.lane][target.slot];
  const defPower = isRanged(targetUnit) && target.lane !== loc.lane ? 0 : estimatePower(targetUnit);
  const kills = atkPower >= targetUnit.defense;
  const dies = !isRanged(attacker) && defPower >= attacker.defense;
  let score = 5;
  if (kills) score += 6;
  if (dies && !kills) score -= 8; // trading down for nothing
  if (dies && kills) score -= 1; // an even trade is fine, just not great
  if (preset.respectBadTrades && dies && !kills) score -= 4;
  score += targetUnit.keywords.includes('taunt') ? 2 : 0; // getting a mandatory taunt out of the way is good tempo
  return {
    action: { type: 'attack', attackerLane: loc.lane, attackerSlot: loc.slot, targetLane: target.lane, targetSlot: target.slot },
    score,
  };
}

function decideCombatAction(game, owner, preset) {
  const you = game.players[owner];
  const opp = game.players[opponentOf(owner)];
  const attackers = allUnitsWithLoc(you).filter((e) => !e.unit.sick && !e.unit.attackedThisTurn);
  if (attackers.length === 0) return { type: 'end_turn' };

  // Lethal check: if every currently-eligible attacker has a clear path to
  // the castle and their combined power meets or beats the opponent's HP,
  // just start swinging at the castle — a coarse but honest approximation
  // (it doesn't simulate the sequence, it just recognizes "this ends it").
  if (preset.checkLethal) {
    let castleTotal = 0;
    const castleAttackers = [];
    for (const a of attackers) {
      const legal = getLegalAttackTargets(game, owner, a.lane, a.slot);
      if (legal.some((t) => t.type === 'castle')) {
        castleTotal += estimatePower(a.unit);
        castleAttackers.push(a);
      }
    }
    if (castleTotal >= opp.hp && castleAttackers.length > 0) {
      const best = castleAttackers.sort((a, b) => estimatePower(b.unit) - estimatePower(a.unit))[0];
      return { type: 'attack', attackerLane: best.lane, attackerSlot: best.slot, targetLane: 'commander' };
    }
  }

  const candidates = [];
  for (const a of attackers) {
    const legal = getLegalAttackTargets(game, owner, a.lane, a.slot);
    for (const target of legal) {
      candidates.push(scoreAttack(game, owner, a.unit, a, target, preset));
    }
  }
  candidates.push({ action: { type: 'end_turn' }, score: 2 });
  return pickWeighted(candidates, preset.randomness);
}

function chooseDiscoverIndex(options, difficulty) {
  if (!options || options.length === 0) return 0;
  if (difficulty === 'easy') return Math.floor(Math.random() * options.length);
  const scored = options.map((c, i) => ({
    i,
    score: c.type === 'spell' ? 4 : (c.power || 0) + (c.defense || 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0].i;
}

// Entry point. Returns one action shape (matching the WS message shapes
// matchRoom.js already knows how to execute), or null if there's genuinely
// nothing for the bot to do right now (e.g. waiting on the human's own
// pending choice).
export function decideAiTurn(game, botOwner, difficulty) {
  const preset = presetFor(difficulty);

  if (game.pendingChoice) {
    if (game.pendingChoice.owner !== botOwner) return null;
    return { type: 'discover_choice', index: chooseDiscoverIndex(game.pendingChoice.options, difficulty) };
  }
  if (game.phase === 'deployment') return decideDeploymentAction(game, botOwner, preset);
  if (game.phase === 'combat') return decideCombatAction(game, botOwner, preset);
  return { type: 'end_turn' };
}
