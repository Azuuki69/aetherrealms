import { createGame, playCard, moveToCombat, attack, endTurn, viewFor } from './game/rules.js';

const SEATS = ['seatA', 'seatB'];

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
        await this.handleJoin(seat, msg.faction);
        return;
      }

      const game = await this.state.storage.get('game');
      if (!game) {
        return this.sendTo(ws, { type: 'error', message: 'The match has not started yet.' });
      }

      switch (msg.type) {
        case 'play_card':
          playCard(game, owner, msg.cardInstanceId, msg.lane, msg.slotIndex);
          break;
        case 'move_to_combat':
          moveToCombat(game, owner);
          break;
        case 'attack':
          attack(game, owner, msg.attackerLane, msg.attackerSlot, msg.targetLane);
          break;
        case 'end_turn':
          endTurn(game, owner);
          break;
        default:
          return this.sendTo(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
      }

      await this.state.storage.put('game', game);
      this.broadcastState(game);
    } catch (err) {
      this.sendTo(ws, { type: 'error', message: err.message || String(err) });
    }
  }

  async handleJoin(seat, faction) {
    const validFactions = ['beast', 'clock', 'damned', 'dwarf', 'dynasty', 'elf', 'fallen', 'human', 'orc', 'undead'];
    if (!validFactions.includes(faction)) {
      const ws = this.state.getWebSockets(seat)[0];
      return this.sendTo(ws, { type: 'error', message: 'Pick a valid faction.' });
    }
    const factions = (await this.state.storage.get('factions')) || {};
    factions[seat] = faction;
    await this.state.storage.put('factions', factions);

    const otherSeat = seat === 'seatA' ? 'seatB' : 'seatA';
    if (factions[otherSeat]) {
      const game = createGame(factions.seatA, factions.seatB);
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

  async webSocketClose(ws) {
    const { seat } = ws.deserializeAttachment();
    this.notifyOthers(seat, { type: 'opponent_disconnected' });
  }

  async webSocketError(ws) {
    const { seat } = ws.deserializeAttachment();
    this.notifyOthers(seat, { type: 'opponent_disconnected' });
  }
}
