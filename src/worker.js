export { MatchRoom } from './matchRoom.js';
export { AccountsRegistry } from './accountsRegistry.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(length = 6) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

function accountsStub(env) {
  return env.ACCOUNTS.get(env.ACCOUNTS.idFromName('global'));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/room' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const code = randomCode();
      // Fix this room's mode/difficulty/boardMode server-side, before the code
      // is even handed back to the client — see MatchRoom.handleInit(). A
      // default ranked room on the Classic board (the only kind that existed
      // before boardMode) skips this entirely, so it costs no extra Durable
      // Object wake-up.
      if (body.mode === 'ai' || body.boardMode === 'single') {
        const id = env.MATCH_ROOM.idFromName(code);
        const stub = env.MATCH_ROOM.get(id);
        await stub.fetch('https://room/init', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: body.mode, difficulty: body.difficulty, boardMode: body.boardMode }),
        });
      }
      return new Response(JSON.stringify({ code }), {
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

    if (
      (url.pathname === '/api/register' && request.method === 'POST') ||
      (url.pathname === '/api/login' && request.method === 'POST') ||
      (url.pathname === '/api/rankings' && request.method === 'GET') ||
      (url.pathname === '/api/site-settings' && request.method === 'GET') ||
      (url.pathname === '/api/hud-layout/save' && request.method === 'POST') ||
      (url.pathname === '/api/hud-layout/load' && request.method === 'POST') ||
      (url.pathname === '/api/ai-stats' && request.method === 'POST') ||
      (url.pathname === '/api/account-info' && request.method === 'POST') ||
      (url.pathname.startsWith('/api/admin/') && request.method === 'POST')
    ) {
      return accountsStub(env).fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
