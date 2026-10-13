import { HttpError, readJsonBody, sendJson } from './http.js';

/** Sessions are bearer capabilities. They contain structured filters, never wallets or raw chats. */
export function createCopilotRoutes({ service }) {
  return async (request, response, url) => {
    const { method } = request, { pathname } = url;
    if (!pathname.startsWith('/api/copilot/')) return false;
    if (method === 'POST' && pathname === '/api/copilot/sessions') {
      const body = await readJsonBody(request, { limit: 16_384 });
      if (body !== null && (typeof body !== 'object' || Array.isArray(body))) throw new HttpError(400, 'invalid_request', 'Body must be an object');
      sendJson(response, 201, { ok: true, context: await service.create(body ?? {}) });
      return true;
    }
    const match = /^\/api\/copilot\/sessions\/([0-9a-f-]{36})(?:\/(messages))?$/u.exec(pathname);
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
