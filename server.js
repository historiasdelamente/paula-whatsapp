const http = require('http');
const { processPaulaMessage } = require('./paula');
const { runFollowUp } = require('./followup');

const PORT = process.env.PORT || 3000;
const DEBOUNCE_MS = 5000; // 5 segundos de silencio antes de procesar

// --- ManyChat API: enviar mensaje de vuelta ---

async function sendViaManyChat(subscriberId, text) {
  const token = process.env.MANYCHAT_API_TOKEN;
  if (!token) {
    console.error('[Paula] MANYCHAT_API_TOKEN no configurado — no se puede enviar respuesta');
    return;
  }

  // Dividir mensajes largos por línea en blanco (Paula envía hasta 2-3 mensajes)
  const parts = text.split(/\n\n/).filter(p => p.trim());
  const messages = parts.map(p => ({ type: 'text', text: p.trim() }));

  const response = await fetch('https://api.manychat.com/fb/sending/sendContent', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      subscriber_id: Number(subscriberId),
      data: {
        version: 'v2',
        content: {
          type: 'whatsapp',
          messages,
        },
      },
    }),
  });

  const data = await response.json();
  if (data.status !== 'success') {
    console.error('[Paula] ManyChat sendContent error:', JSON.stringify(data));
  } else {
    console.log(`[Paula] -> ManyChat OK (${messages.length} msg(s) enviados)`);
  }
  return data;
}

// --- Message Buffer (in-memory con setTimeout) ---
// Map<userId, { messages: string[], timer: NodeJS.Timeout, replyType: string, phone: string }>
const messageBuffer = new Map();

function bufferMessage(userId, message, replyType, phone) {
  const uid = String(userId);
  const buffer = messageBuffer.get(uid);

  if (buffer) {
    // Ya hay un buffer activo — agregar mensaje y resetear timer
    buffer.messages.push(message);
    buffer.replyType = replyType;
    buffer.phone = phone;
    clearTimeout(buffer.timer);
    buffer.timer = setTimeout(() => processBuffer(uid), DEBOUNCE_MS);
    console.log(`[Paula] ${uid}: buffered (${buffer.messages.length} msgs acumulados)`);
  } else {
    // Primer mensaje — crear buffer y arrancar timer
    const entry = {
      messages: [message],
      replyType,
      phone,
      timer: setTimeout(() => processBuffer(uid), DEBOUNCE_MS),
    };
    messageBuffer.set(uid, entry);
    console.log(`[Paula] ${uid}: buffer iniciado, esperando ${DEBOUNCE_MS}ms...`);
  }
}

async function processBuffer(userId) {
  const buffer = messageBuffer.get(userId);
  if (!buffer) return;

  messageBuffer.delete(userId);

  const combinedMessage = buffer.messages.join('\n');
  console.log(`[Paula] ${userId}: procesando ${buffer.messages.length} msg(s) -> "${combinedMessage.substring(0, 120)}..."`);

  try {
    const paulaResponse = await processPaulaMessage(
      userId, combinedMessage, buffer.replyType, buffer.phone
    );

    console.log(`[Paula] ${userId} -> "${paulaResponse.substring(0, 120)}..."`);

    await sendViaManyChat(userId, paulaResponse);
  } catch (error) {
    console.error(`[Paula] Error procesando buffer de ${userId}:`, error.message);
    // Intentar enviar mensaje de error a la usuaria
    try {
      await sendViaManyChat(userId, 'En este momento no puedo responder. Escribeme de nuevo en unos minutos \uD83D\uDDA4');
    } catch (e) {
      console.error('[Paula] Error enviando mensaje de error:', e.message);
    }
  }
}

// --- HTTP Server ---

const server = http.createServer(async (req, res) => {
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
      mode: 'async',
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

        // Media messages — procesar y responder via ManyChat API inmediatamente
        if (replyType !== 'text') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ bot_response: '' }));

          try {
            const paulaResponse = await processPaulaMessage(
              String(userId), String(userMessage || ''), String(replyType), String(phone)
            );
            await sendViaManyChat(String(userId), paulaResponse);
          } catch (err) {
            console.error('[Paula] Error procesando media:', err.message);
          }
          return;
        }

        // Text messages — buffer con debounce
        bufferMessage(String(userId), String(userMessage || ''), String(replyType), String(phone));

        // Responder vacío inmediatamente — la respuesta real llega via ManyChat API
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ bot_response: '' }));

      } catch (error) {
        console.error('[Paula Error]', error.message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ bot_response: '' }));
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
  console.log(`[Paula] Modo: ASYNC (webhook inmediato + ManyChat API callback)`);
  console.log(`[Paula] Buffer: ${DEBOUNCE_MS}ms debounce`);
  console.log(`[Paula] Webhook: POST /webhook`);
});
