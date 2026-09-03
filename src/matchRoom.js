import { createGame, playCard, moveToCombat, attack, moveUnit, endTurn, viewFor, opponentOf } from './game/rules.js';

const SEATS = ['seatA', 'seatB'];
const TURN_TIMEOUT_MS = 60_000;

export class MatchRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket connection.', { status: 400 });
    }

    const takenSeats = new Set();
    for (const tag of SEATS) {
      if (this.state.getWebSockets(tag).length > 0) takenSeats.add(tag);
    }
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
          game.turnDeadlineAt = Date.now() + TURN_TIMEOUT_MS;
          await this.state.storage.setAlarm(game.turnDeadlineAt);
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
        case 'discover_choice': {
          const choice = game.pendingChoice;
          if (!choice || choice.owner !== owner) throw new Error('No pending choice for you to resolve.');
          const idx = msg.index;
          if (!Number.isInteger(idx) || idx < 0 || idx >= choice.options.length) {
            throw new Error('Invalid choice.');
          }
          game.players[owner].hand.push(choice.options[idx]);
          game.log.push(`${owner} discovers ${choice.options[idx].name}.`);
          game.pendingChoice = null;
          break;
        }
        default:
          return this.sendTo(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
      }

      if (!game.winner) {
        game.turnDeadlineAt = Date.now() + TURN_TIMEOUT_MS;
        await this.state.storage.setAlarm(game.turnDeadlineAt);
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

  async reportResult(game) {
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

  async handleJoin(seat, faction, username) {
    const validFactions = ['beast', 'clock', 'damned', 'dwarf', 'dynasty', 'elf', 'fallen', 'human', 'orc', 'undead'];
    if (!validFactions.includes(faction)) {
      const ws = this.state.getWebSockets(seat)[0];
      return this.sendTo(ws, { type: 'error', message: 'Pick a valid faction.' });
    }
    const factions = (await this.state.storage.get('factions')) || {};
    factions[seat] = faction;
    await this.state.storage.put('factions', factions);

    const usernames = (await this.state.storage.get('usernames')) || {};
    usernames[seat] = username || null;
    await this.state.storage.put('usernames', usernames);

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
    if (!game.winner) {
      game.turnDeadlineAt = Date.now() + TURN_TIMEOUT_MS;
      await this.state.storage.setAlarm(game.turnDeadlineAt);
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
