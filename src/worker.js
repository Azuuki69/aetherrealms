export { MatchRoom } from './matchRoom.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(length = 6) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/room' && request.method === 'POST') {
      return new Response(JSON.stringify({ code: randomCode() }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    const wsMatch = url.pathname.match(/^\/api\/room\/([A-Za-z0-9]{4,8})\/ws$/);
    if (wsMatch) {
      const code = wsMatch[1].toUpperCase();
      const id = env.MATCH_ROOM.idFromName(code);
      const stub = env.MATCH_ROOM.get(id);
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
