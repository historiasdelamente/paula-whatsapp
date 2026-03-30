const http = require('http');
const { processPaulaMessage } = require('./paula');
const { runFollowUp } = require('./followup');

const PORT = process.env.PORT || 3000;
const DEBOUNCE_MS = 5000;     // 5 segundos de silencio antes de procesar
const POLL_INTERVAL = 500;    // revisar cada 500ms
const MAX_WAIT_MS = 20000;    // timeout de seguridad: 20s máximo

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Message Buffer (in-memory) ---
// Acumula mensajes de una misma usuaria antes de procesarlos
// Map<userId, { messages: string[], lastTime: number, processing: boolean }>
const messageBuffer = new Map();

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
      buffer: `${DEBOUNCE_MS}ms debounce`,
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
        const replyType = data.reply_type || 'text';
        const phone = data.phone || '';

        if (!userId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Falta campo: user_id' }));
          return;
        }

        console.log(`[Paula] ${userId} (${replyType}): "${userMessage || '[media]'}"`);

        // Media messages bypass the buffer — respond immediately
        if (replyType !== 'text') {
          const paulaResponse = await processPaulaMessage(
            String(userId), String(userMessage || ''), String(replyType), String(phone)
          );
          console.log(`[Paula] -> "${paulaResponse.substring(0, 100)}..."`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ bot_response: paulaResponse }));
          return;
        }

        // --- Buffer logic for text messages ---
        const uid = String(userId);
        const buffer = messageBuffer.get(uid);

        if (buffer && !buffer.processing) {
          // Buffer exists — add message, update timestamp, return empty
          buffer.messages.push(String(userMessage || ''));
          buffer.lastTime = Date.now();
          buffer.replyType = String(replyType);
          buffer.phone = String(phone);
          console.log(`[Paula] ${uid}: buffered (${buffer.messages.length} msgs acumulados)`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ bot_response: '' }));
          return;
        }

        // First message — create buffer and hold connection
        messageBuffer.set(uid, {
          messages: [String(userMessage || '')],
          lastTime: Date.now(),
          processing: false,
          replyType: String(replyType),
          phone: String(phone),
        });

        console.log(`[Paula] ${uid}: primera request, esperando debounce ${DEBOUNCE_MS}ms...`);
        const startTime = Date.now();

        // Polling: wait until debounce window passes
        while (true) {
          await sleep(POLL_INTERVAL);

          const current = messageBuffer.get(uid);
          if (!current || current.processing) {
            // Buffer was consumed or is being processed
            console.log(`[Paula] ${uid}: buffer ya consumido`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ bot_response: '' }));
            return;
          }

          const elapsed = Date.now() - current.lastTime;

          if (elapsed >= DEBOUNCE_MS) {
            break; // Debounce cumplido
          }

          // Safety timeout
          if (Date.now() - startTime > MAX_WAIT_MS) {
            console.log(`[Paula] ${uid}: safety timeout alcanzado`);
            break;
          }
        }

        // Claim the buffer
        const claimed = messageBuffer.get(uid);
        if (!claimed || claimed.processing) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ bot_response: '' }));
          return;
        }

        claimed.processing = true; // Mark as processing to prevent new claims
        const combinedMessage = claimed.messages.join('\n');
        const finalReplyType = claimed.replyType;
        const finalPhone = claimed.phone;
        messageBuffer.delete(uid); // Clean up

        console.log(`[Paula] ${uid}: procesando ${claimed.messages.length} msg(s) -> "${combinedMessage.substring(0, 100)}..."`);

        const paulaResponse = await processPaulaMessage(
          uid, combinedMessage, finalReplyType, finalPhone
        );

        console.log(`[Paula] -> "${paulaResponse.substring(0, 100)}..."`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ bot_response: paulaResponse }));

      } catch (error) {
        console.error('[Paula Error]', error.message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          bot_response: 'En este momento no puedo responder. Escribeme de nuevo en unos minutos \uD83D\uDDA4',
        }));
      }
    });
    return;
  }

  // Cron endpoint for follow-ups
  if (req.method === 'GET' && req.url === '/cron/followup') {
    try {
      const result = await runFollowUp();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', ...result }));
    } catch (error) {
      console.error('[FollowUp Error]', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`[Paula] Servidor activo en puerto ${PORT}`);
  console.log(`[Paula] Modelo: ${process.env.PAULA_MODEL || 'openai/gpt-4.1-mini'}`);
  console.log(`[Paula] Buffer: ${DEBOUNCE_MS}ms debounce`);
  console.log(`[Paula] Webhook: POST /webhook`);
});
