import { createGame, playCard, moveToCombat, attack, moveUnit, endTurn, viewFor, opponentOf } from './game/rules.js';
import { decideAiTurn } from './game/aiPlayer.js';

const SEATS = ['seatA', 'seatB'];
const TURN_TIMEOUT_MS = 60_000;
const VALID_FACTIONS = ['beast', 'clock', 'damned', 'dwarf', 'dynasty', 'elf', 'fallen', 'human', 'orc', 'undead'];
const VALID_DIFFICULTIES = ['easy', 'normal', 'hard'];
// A short, natural-feeling gap between bot actions (see alarm()'s AI branch)
// — long enough to read as "thinking", nowhere near the 60s human turn
// timer, and re-rolled per step so it doesn't feel metronomic.
const BOT_STEP_DELAY_MS = [700, 1300];

export class MatchRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    // Internal call from the worker's POST /api/room handler, made before any
    // player ever connects — this is the only place `mode`/`difficulty` are
    // ever written, which is what makes the ranked/AI split hold even against
    // a malicious or buggy client (no later WebSocket message can touch it).
    if (url.pathname === '/init' && request.method === 'POST') {
      return this.handleInit(request);
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket connection.', { status: 400 });
    }

    const roomMode = (await this.state.storage.get('mode')) || 'ranked';
    const takenSeats = new Set();
    for (const tag of SEATS) {
      if (this.state.getWebSockets(tag).length > 0) takenSeats.add(tag);
    }
    // An AI room's seatB is a bot, never a real socket — treating it as
    // permanently taken means a second real connection is rejected exactly
    // like a normal full match, so an AI room can never quietly become a
    // disguised 2-human ranked match.
    if (roomMode === 'ai') takenSeats.add('seatB');
    const freeSeat = SEATS.find((s) => !takenSeats.has(s));
    if (!freeSeat) {
      return new Response('This match already has two players.', { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server, [freeSeat]);
    server.serializeAttachment({ seat: freeSeat });

    await this.afterJoin(freeSeat);

    return new Response(null, { status: 101, webSocket: client });
  }

  seatOwner(seat) {
    return seat === 'seatA' ? 'A' : 'B';
  }

  // Fixes this room's mode for its entire lifetime, before any player has
  // connected. Idempotent-by-construction: it only ever runs once, right
  // after the worker generates a fresh room code, so there's no later point
  // where a client message could reach this and flip a room's mode.
  async handleInit(request) {
    const body = await request.json().catch(() => ({}));
    const mode = body.mode === 'ai' ? 'ai' : 'ranked';
    await this.state.storage.put('mode', mode);
    if (mode === 'ai') {
      const difficulty = VALID_DIFFICULTIES.includes(body.difficulty) ? body.difficulty : 'normal';
      const aiFaction = VALID_FACTIONS[Math.floor(Math.random() * VALID_FACTIONS.length)];
      await this.state.storage.put('difficulty', difficulty);
      await this.state.storage.put('aiFaction', aiFaction);
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  }

  async afterJoin(seat) {
    const factions = (await this.state.storage.get('factions')) || {};
    const game = await this.state.storage.get('game');
    const ws = this.state.getWebSockets(seat)[0];
    if (!ws) return;
    if (game) {
      this.sendTo(ws, { type: 'state', ...viewFor(game, this.seatOwner(seat)) });
      this.notifyOthers(seat, { type: 'opponent_reconnected' });
    } else if (factions[seat]) {
      this.sendTo(ws, { type: 'waiting_for_opponent' });
    } else {
      this.sendTo(ws, { type: 'need_faction' });
    }
  }

  async webSocketMessage(ws, raw) {
    const { seat } = ws.deserializeAttachment();
    const owner = this.seatOwner(seat);
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.sendTo(ws, { type: 'error', message: 'Malformed message.' });
    }

    try {
      if (msg.type === 'join') {
        const existingGame = await this.state.storage.get('game');
        if (existingGame) {
          // Reconnecting to a match already in progress — just resend their view.
          return this.sendTo(ws, { type: 'state', ...viewFor(existingGame, owner) });
        }
        const username = await this.resolveUsername(msg.token);
        await this.handleJoin(seat, msg.faction, username);
        return;
      }

      const game = await this.state.storage.get('game');
      if (!game) {
        return this.sendTo(ws, { type: 'error', message: 'The match has not started yet.' });
      }
      const wasOver = !!game.winner;

      if (game.phase === 'coinflip') {
        if (msg.type !== 'coinflip_ack') {
          return this.sendTo(ws, { type: 'error', message: 'Waiting for the coin flip to resolve.' });
        }
        game.coinFlipAcks = game.coinFlipAcks || { A: false, B: false };
        game.coinFlipAcks[owner] = true;
        if (game.coinFlipAcks.A && game.coinFlipAcks.B) {
          game.phase = 'deployment';
          game.log.push(`Coin flip complete — Player ${game.turn} goes first.`);
          await this.scheduleNextAlarm(game);
        }
        await this.state.storage.put('game', game);
        this.broadcastState(game);
        return;
      }

      // A Discover-style effect parks the game until the choosing player
      // resolves it — mirrors the coinflip gate above exactly, including
      // blocking chat/surrender while it's pending, the same precedented
      // limitation coinflip already has.
      if (game.pendingChoice && msg.type !== 'discover_choice') {
        return this.sendTo(ws, { type: 'error', message: 'Resolve the pending card choice first.' });
      }

      switch (msg.type) {
        case 'chat': {
          const text = (msg.text ?? '').toString().trim().slice(0, 240);
          if (!text) return;
          const chatMsg = { type: 'chat', owner, text };
          for (const s of SEATS) {
            const seatWs = this.state.getWebSockets(s)[0];
            if (seatWs) this.sendTo(seatWs, chatMsg);
          }
          return;
        }
        case 'play_card':
          playCard(game, owner, msg.cardInstanceId, msg.lane, msg.slotIndex, msg.spellTarget);
          break;
        case 'move_to_combat':
          moveToCombat(game, owner);
          break;
        case 'attack':
          attack(game, owner, msg.attackerLane, msg.attackerSlot, msg.targetLane, msg.targetSlot);
          break;
        case 'move_unit':
          moveUnit(game, owner, msg.fromLane, msg.fromSlot, msg.toLane, msg.toSlot);
          break;
        case 'end_turn':
          endTurn(game, owner);
          break;
        case 'surrender':
          game.winner = opponentOf(owner);
          game.phase = 'gameover';
          game.log.push(`${owner} surrenders the match.`);
          break;
        case 'discover_choice':
          this.resolveDiscoverChoice(game, owner, msg.index);
          break;
        default:
          return this.sendTo(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
      }

      if (!game.winner) {
        await this.scheduleNextAlarm(game);
      } else {
        await this.state.storage.deleteAlarm();
      }
      await this.state.storage.put('game', game);
      this.broadcastState(game);
      if (!wasOver && game.winner) await this.reportResult(game);
    } catch (err) {
      this.sendTo(ws, { type: 'error', message: err.message || String(err) });
    }
  }

  async resolveUsername(token) {
    if (!token) return null;
    try {
      const stub = this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName('global'));
      const res = await stub.fetch('https://accounts/resolve-session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      return data.username || null;
    } catch {
      return null;
    }
  }

  // Dispatches to one of two entirely separate reporting paths depending on
  // `game.mode`, fixed once at room creation and never touched by any client
  // message (see handleInit/handleJoin). Deliberately not "one function with
  // an if inside" — ranked and AI results hit two different AccountsRegistry
  // endpoints, so there's no shared code path a future edit could
  // accidentally leak an AI result into ranked stats through.
  async reportResult(game) {
    if (game.mode === 'ai') return this.reportAiResult(game);
    return this.reportRankedResult(game);
  }

  async reportRankedResult(game) {
    try {
      const factions = (await this.state.storage.get('factions')) || {};
      const usernames = (await this.state.storage.get('usernames')) || {};
      const winnerSeat = game.winner === 'A' ? 'seatA' : 'seatB';
      const loserSeat = game.winner === 'A' ? 'seatB' : 'seatA';
      const stub = this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName('global'));
      await stub.fetch('https://accounts/record-result', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          winnerUsername: usernames[winnerSeat] || null,
          winnerFaction: factions[winnerSeat] || null,
          loserUsername: usernames[loserSeat] || null,
          loserFaction: factions[loserSeat] || null,
        }),
      });
    } catch {
      /* rankings are best-effort — never let this break the match */
    }
  }

  // The human is always seatA in an AI room (see fetch()'s seatB refusal), so
  // this only ever reports the human's own win/loss — never anything derived
  // from the bot "seat", and never anywhere near /record-result or
  // `factionStats`/`playerStats`.
  async reportAiResult(game) {
    try {
      const usernames = (await this.state.storage.get('usernames')) || {};
      const humanUsername = usernames.seatA || null;
      if (!humanUsername) return;
      const won = game.winner === 'A';
      const stub = this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName('global'));
      await stub.fetch('https://accounts/record-ai-result', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: humanUsername, won }),
      });
    } catch {
      /* AI stats are best-effort — never let this break the match */
    }
  }

  async handleJoin(seat, faction, username) {
    if (!VALID_FACTIONS.includes(faction)) {
      const ws = this.state.getWebSockets(seat)[0];
      return this.sendTo(ws, { type: 'error', message: 'Pick a valid faction.' });
    }
    const factions = (await this.state.storage.get('factions')) || {};
    factions[seat] = faction;
    await this.state.storage.put('factions', factions);

    const usernames = (await this.state.storage.get('usernames')) || {};
    usernames[seat] = username || null;
    await this.state.storage.put('usernames', usernames);

    const mode = (await this.state.storage.get('mode')) || 'ranked';

    // AI rooms never wait for a second real join — as soon as the one human
    // seat picks a faction, seat the bot with the faction/difficulty fixed
    // at room creation (handleInit) and start the game immediately.
    if (mode === 'ai' && seat === 'seatA') {
      const difficulty = (await this.state.storage.get('difficulty')) || 'normal';
      const aiFaction = (await this.state.storage.get('aiFaction')) || VALID_FACTIONS[0];
      factions.seatB = aiFaction;
      usernames.seatB = `AI · ${difficulty[0].toUpperCase()}${difficulty.slice(1)}`;
      await this.state.storage.put('factions', factions);
      await this.state.storage.put('usernames', usernames);

      const firstPlayer = crypto.getRandomValues(new Uint32Array(1))[0] % 2 === 0 ? 'A' : 'B';
      const game = createGame(factions.seatA, factions.seatB, firstPlayer, usernames.seatA, usernames.seatB);
      game.mode = 'ai';
      game.difficulty = difficulty;
      // The bot has no coin-flip animation to watch — it acks instantly, so
      // the match only ever waits on the human's own ack, same UX as ranked.
      game.coinFlipAcks = { A: false, B: true };
      await this.state.storage.put('game', game);
      this.broadcastState(game);
      return;
    }

    const otherSeat = seat === 'seatA' ? 'seatB' : 'seatA';
    if (factions[otherSeat]) {
      const firstPlayer = crypto.getRandomValues(new Uint32Array(1))[0] % 2 === 0 ? 'A' : 'B';
      const game = createGame(factions.seatA, factions.seatB, firstPlayer, usernames.seatA, usernames.seatB);
      await this.state.storage.put('game', game);
      this.broadcastState(game);
    } else {
      const ws = this.state.getWebSockets(seat)[0];
      this.sendTo(ws, { type: 'waiting_for_opponent' });
    }
  }

  broadcastState(game) {
    for (const seat of SEATS) {
      const ws = this.state.getWebSockets(seat)[0];
      if (ws) this.sendTo(ws, { type: 'state', ...viewFor(game, this.seatOwner(seat)) });
    }
  }

  notifyOthers(seat, message) {
    for (const other of SEATS) {
      if (other === seat) continue;
      const ws = this.state.getWebSockets(other)[0];
      if (ws) this.sendTo(ws, message);
    }
  }

  sendTo(ws, message) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      /* socket already closed */
    }
  }

  // Shared by a human's own 'discover_choice' message and the bot's
  // equivalent decision in takeBotStep() — one implementation, so the two
  // paths can never quietly diverge.
  resolveDiscoverChoice(game, owner, idx) {
    const choice = game.pendingChoice;
    if (!choice || choice.owner !== owner) throw new Error('No pending choice for you to resolve.');
    if (!Number.isInteger(idx) || idx < 0 || idx >= choice.options.length) {
      throw new Error('Invalid choice.');
    }
    game.players[owner].hand.push(choice.options[idx]);
    game.log.push(`${owner} discovers ${choice.options[idx].name}.`);
    game.pendingChoice = null;
  }

  // Single place that decides the next alarm deadline, used everywhere a
  // deadline needs (re)setting. An AI room whose turn just landed on the bot
  // gets a short thinking-time delay instead of the 60s human timer — see
  // BOT_STEP_DELAY_MS — so alarm() below naturally paces the bot one action
  // at a time rather than resolving its whole turn instantly.
  async scheduleNextAlarm(game) {
    if (game.mode === 'ai' && game.turn === 'B' && game.phase !== 'coinflip') {
      const [min, max] = BOT_STEP_DELAY_MS;
      game.turnDeadlineAt = Date.now() + min + Math.floor(Math.random() * (max - min));
    } else {
      game.turnDeadlineAt = Date.now() + TURN_TIMEOUT_MS;
    }
    await this.state.storage.setAlarm(game.turnDeadlineAt);
  }

  // Runs exactly one bot action through the same rules.js functions a human
  // WebSocket message would call — see aiPlayer.js for the decision logic
  // and its hidden-information contract. Never touches game state directly
  // beyond what those functions already do.
  takeBotStep(game) {
    const difficulty = game.difficulty || 'normal';
    let action;
    try {
      action = decideAiTurn(game, 'B', difficulty);
    } catch (err) {
      game.log.push(`AI decision error (${err.message || err}) — passing its turn.`);
      endTurn(game, 'B');
      return;
    }
    if (!action) return; // nothing to do this tick (e.g. waiting on the human's own pending choice)
    try {
      switch (action.type) {
        case 'play_card':
          playCard(game, 'B', action.cardInstanceId, action.lane, action.slotIndex, action.spellTarget);
          break;
        case 'move_to_combat':
          moveToCombat(game, 'B');
          break;
        case 'attack':
          attack(game, 'B', action.attackerLane, action.attackerSlot, action.targetLane, action.targetSlot);
          break;
        case 'move_unit':
          moveUnit(game, 'B', action.fromLane, action.fromSlot, action.toLane, action.toSlot);
          break;
        case 'discover_choice':
          this.resolveDiscoverChoice(game, 'B', action.index);
          break;
        case 'end_turn':
        default:
          endTurn(game, 'B');
          break;
      }
    } catch (err) {
      // A bad bot decision must never corrupt the match, hang the turn, or
      // retry the same illegal action forever — log it and safely end the
      // bot's turn instead. This match was never ranked to begin with, so
      // there's no result to accidentally grant here either way.
      game.log.push(`AI action failed (${err.message || err}) — passing its turn.`);
      if (game.turn === 'B' && !game.winner) endTurn(game, 'B');
    }
  }

  // Server-authoritative turn timer, driven by the Durable Object Alarms API
  // (never a client-side timer, since it forces a real state change).
  // Rescheduled to a fresh deadline by every successful player action (see
  // webSocketMessage and the coinflip_ack branch above) — this only ever
  // fires when 60s have passed with zero successful actions from whoever's
  // turn it is, including if that player disconnected entirely and never
  // comes back. Running out of time costs the turn, not the match — it just
  // forces the same end_turn a player would trigger themselves, so an
  // unresponsive opponent stalls the game rather than auto-winning it;
  // surrender (see the 'surrender' case above) is the deliberate way to end
  // a match early now.
  //
  // In an AI room, this exact same alarm also drives the bot: scheduleNextAlarm()
  // gives the bot's turn a short delay instead of the 60s timeout, and this
  // handler takes one bot action per firing rather than forcing an end_turn —
  // see takeBotStep().
  async alarm() {
    const game = await this.state.storage.get('game');
    if (!game || game.winner || game.phase === 'coinflip') return;
    if (Date.now() < game.turnDeadlineAt) {
      // A newer deadline was set after this alarm was scheduled — reschedule
      // instead of acting early. setAlarm() should already have replaced this
      // firing, so this is a defensive guard, not the expected path.
      await this.state.storage.setAlarm(game.turnDeadlineAt);
      return;
    }

    if (game.mode === 'ai' && game.turn === 'B') {
      this.takeBotStep(game);
    } else {
      // A pending Discover choice blocks end_turn/surrender just like it
      // blocks everything else — nothing else would ever clear it, so a
      // stale choice would otherwise leak into the next player's turn.
      if (game.pendingChoice) {
        game.log.push(`${game.pendingChoice.owner}'s pending card choice times out and is discarded.`);
        game.pendingChoice = null;
      }
      const timedOutPlayer = game.turn;
      game.log.push(`${timedOutPlayer} ran out of time — turn passes automatically.`);
      endTurn(game, timedOutPlayer);
    }

    if (!game.winner) {
      await this.scheduleNextAlarm(game);
    } else {
      await this.state.storage.deleteAlarm();
    }
    await this.state.storage.put('game', game);
    this.broadcastState(game);
    if (game.winner) await this.reportResult(game);
  }

  async webSocketClose(ws) {
    const { seat } = ws.deserializeAttachment();
    this.notifyOthers(seat, { type: 'opponent_disconnected' });
  }

  async webSocketError(ws) {
    const { seat } = ws.deserializeAttachment();
    this.notifyOthers(seat, { type: 'opponent_disconnected' });
  }
}
