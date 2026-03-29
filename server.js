const http = require('http');
const { processPaulaMessage } = require('./paula');

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      agent: 'Paula - Historias de la Mente',
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  // Webhook endpoint for ManyChat
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';

    req.on('data', chunk => { body += chunk; });

    req.on('end', async () => {
      try {
        const data = JSON.parse(body);

        const userId = data.user_id || data.subscriber_id;
        const userMessage = data.user_message || data.last_input_text || data.message;

        if (!userId || !userMessage) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Faltan campos: user_id y user_message' }));
          return;
        }

        console.log(`[Paula] ${userId}: "${userMessage}"`);

        const paulaResponse = await processPaulaMessage(String(userId), String(userMessage));

        console.log(`[Paula] → "${paulaResponse.substring(0, 100)}..."`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ bot_response: paulaResponse }));

      } catch (error) {
        console.error('[Paula Error]', error.message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          bot_response: 'En este momento no puedo responder. Escríbeme de nuevo en unos minutos 🖤',
        }));
      }
    });
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`[Paula] Servidor activo en puerto ${PORT}`);
  console.log(`[Paula] Modelo: ${process.env.PAULA_MODEL || 'openai/gpt-4.1-mini'}`);
  console.log(`[Paula] Webhook: POST /webhook`);
});
