import { HttpError, readJsonBody, sendJson } from './http.js';

/** Sessions are bearer capabilities. They contain structured filters, never wallets or raw chats. */
export function createCopilotRoutes({ service }) {
  return async (request, response, url) => {
    const { method } = request, { pathname } = url;
    if (!pathname.startsWith('/api/copilot/')) return false;
    const action = /^\/api\/copilot\/sessions\/([0-9a-f-]{36})\/actions\/([0-9a-f-]{36})\/(confirm|cancel)$/u.exec(pathname);
    if (action && method === 'POST') {
      const body = await readJsonBody(request, { limit: 16_384 });
      sendJson(response, 200, { ok: true, ...action[3] === 'cancel' ? await service.cancelAction(action[1], action[2]) : await service.confirmAction(action[1], action[2], body ?? {}) });
      return true;
    }
    if (method === 'POST' && pathname === '/api/copilot/sessions') {
      const body = await readJsonBody(request, { limit: 16_384 });
      if (body !== null && (typeof body !== 'object' || Array.isArray(body))) throw new HttpError(400, 'invalid_request', 'Body must be an object');
      sendJson(response, 201, { ok: true, context: await service.create(body ?? {}) });
      return true;
    }
    const match = /^\/api\/copilot\/sessions\/([0-9a-f-]{36})(?:\/(messages|stream|watchlist))?$/u.exec(pathname);
    if (match?.[2] === 'watchlist' && method === 'PUT') {
      const body = await readJsonBody(request, { limit: 16_384 });
      sendJson(response, 200, { ok: true, context: await service.watch(match[1], body?.pool_ids) });
      return true;
    }
    if (match?.[2] === 'stream' && method === 'GET') {
      await service.enqueue(match[1], async () => {
        const context = await service.get(match[1]);
        const raw = request.headers['last-event-id'] ?? url.searchParams.get('last_event_id');
        const cursor = raw === null || raw === undefined ? 0 : Number(raw);
        if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > (context.update_seq ?? 0)) throw new HttpError(400, 'invalid_stream_cursor', 'Invalid Copilot event cursor');
        const emit = (event, data) => {
          if (response.destroyed || response.writableEnded) return;
          if (!response.write(`${event === 'COPILOT_RERANK' ? `id: ${data.seq}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) response.end();
          if (event === 'SESSION_CLOSED') response.end();
        };
        const unsubscribe = service.subscribe(match[1], emit);
        response.on('close', () => { unsubscribe(); clearInterval(heartbeat); });
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' });
        response.write('retry: 3000\n\n');
        emit('connected', { seq: context.update_seq ?? 0, mode: context.mode, generation: context.generation });
        if (context.last_update && context.last_update.seq > cursor) {
          // Latest state replaces a missed burst; its sequence makes reconnects idempotent.
          emit('COPILOT_RERANK', { ...context.last_update, replayed: true,
            result: { ...context.last_update.result, context: service.publicContext(context), mode: context.mode, generation: context.generation } });
        }
        const heartbeat = setInterval(() => {
          service.get(match[1]).then(() => { if (!response.destroyed && !response.writableEnded) response.write(': heartbeat\n\n'); })
            .catch((error) => emit('SESSION_CLOSED', { code: error.code }));
        }, 15_000);
        heartbeat.unref();
      });
      return true;
    }
    if (match && !match[2] && method === 'GET') {
      sendJson(response, 200, { ok: true, context: await service.get(match[1]) });
      return true;
    }
    if (match && !match[2] && method === 'DELETE') {
      await service.delete(match[1]);
      sendJson(response, 200, { ok: true, deleted: true });
      return true;
    }
    if (method === 'POST' && (pathname === '/api/copilot/query' || match?.[2] === 'messages')) {
      const body = service.validate(await readJsonBody(request, { limit: 16_384 }));
      const stream = String(request.headers.accept ?? '').includes('text/event-stream');
      let seq = 0;
      const emit = (event, data) => {
        if (response.destroyed || response.writableEnded) return;
        if (!response.headersSent) response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
        response.write(`id: ${++seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const result = await service.query(body, { sessionId: match?.[1], onStructured: stream ? (data) => emit('result', data) : undefined });
      if (stream) {
        emit('narrative', { narrative: result.narrative, narrative_mode: result.narrative_mode, context: result.context });
        emit('done', { ok: true });
        response.end();
      } else sendJson(response, 200, { ok: true, ...result });
      return true;
    }
    throw new HttpError(404, 'copilot_route_not_found', 'Unknown Copilot route');
  };
}
