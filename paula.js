const fs = require('fs');
const path = require('path');
const { withRetry, fetchWithTimeout } = require('./utils');

// --- Captura de lead -> embudo desing_web (/api/leads/capture) ---
// Paula NO manda el correo ni el PDF: solo dispara el endpoint publico del sitio,
// que agrega el contacto a Resend, manda el correo 1 (libro + grupo) y programa
// la secuencia. Paula entrega los links del grupo y el curso en el chat (04_flujos).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// La IA marca AL FINAL de su mensaje, cuando ya tiene nombre + correo valido:
//   [[LEAD: nombre=Luisa | email=luisa@correo.com]]
// paula.js lo detecta, dispara el embudo y BORRA la marca antes de responder.
const LEAD_TAG_RE = /\[\[\s*LEAD:\s*nombre\s*=\s*([^|\]]+?)\s*\|\s*email\s*=\s*([^\]]+?)\s*\]\]/i;

function parseLeadTag(text) {
  if (!text) return null;
  const m = text.match(LEAD_TAG_RE);
  if (!m) return null;
  const nombre = m[1].trim();
  const email = m[2].trim().toLowerCase();
  if (!nombre || nombre.length < 2 || nombre.length > 80) return null;
  if (!EMAIL_RE.test(email) || email.length > 200) return null;
  return { nombre, email };
}

function stripLeadTag(text) {
  return (text || '').replace(LEAD_TAG_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

async function enviarLeadCaptura({ nombre, email, origen }) {
  const baseUrl = process.env.WEB_BASE_URL || 'https://historiasdelamente.com';
  const response = await fetchWithTimeout(`${baseUrl}/api/leads/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      nombre,
      utmSource: origen || 'whatsapp',
      utmMedium: 'paula',
      utmCampaign: 'clase_libro_funnel',
      utmContent: 'paula_bot',
    }),
    timeoutMs: 12000,
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`leads/capture (${response.status}): ${err.slice(0, 200)}`);
  }
  return response.json();
}

// --- Supabase Config ---

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL y SUPABASE_SERVICE_KEY deben estar configuradas');
  }
  return { url, key };
}

async function supabaseQuery(endpoint, options = {}) {
  const { url, key } = getSupabaseConfig();
  const headers = {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  if (options.method === 'POST') {
    headers['Prefer'] = 'return=representation';
  }
  const response = await fetchWithTimeout(`${url}/rest/v1/${endpoint}`, {
    ...options,
    headers: { ...headers, ...options.headers },
    timeoutMs: 8000,
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Supabase error (${response.status}): ${error}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

// --- Prompt Loading ---

const PROMPTS_DIR = path.join(__dirname, 'prompts');
const promptCache = {};

function loadPrompt(filename) {
  if (promptCache[filename]) return promptCache[filename];
  const filePath = path.join(PROMPTS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    console.error(`[Paula] Prompt no encontrado: ${filePath}`);
    return '';
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  promptCache[filename] = content;
  return content;
}

setInterval(() => {
  Object.keys(promptCache).forEach(k => delete promptCache[k]);
}, 5 * 60 * 1000);

// --- Media Handling ---

const MEDIA_RESPONSES = {
  audio: 'No puedo escuchar audios por aqui, pero me encantaria leerte. Me escribes lo que querias decirme? \uD83D\uDC9B',
  image: 'Vi que me mandaste una imagen pero no puedo verla por aqui. Si necesitas contarme algo, escribemelo y te ayudo \u2728',
  video: 'Recibi tu video pero no puedo reproducirlo por aqui. Me cuentas en texto lo que querias mostrarme? \uD83D\uDC9B',
  sticker: 'Recibi tu sticker \uD83D\uDC9B Cuentame, como estas?',
  document: 'Recibi tu archivo pero no puedo abrirlo por aqui. Si necesitas algo, escribemelo y te ayudo \u2728',
  location: 'Recibi tu ubicacion. Si necesitas algo, cuentame por texto y te ayudo \uD83D\uDC9B',
};

function isMediaReply(replyType) {
  return replyType && replyType !== 'text' && MEDIA_RESPONSES[replyType];
}

// Detect media URLs in message text (ManyChat sends S3 URLs for images/audio)
function detectMediaInText(message) {
  if (!message) return null;
  if (message.match(/\.(jpg|jpeg|png|gif|webp|bmp)/i) || message.includes('manybot-files') && message.match(/\.(jpg|jpeg|png|gif|webp)/i)) return 'image';
  if (message.match(/\.(ogg|mp3|wav|m4a|opus|aac)/i)) return 'audio';
  if (message.match(/\.(mp4|mov|avi|webm)/i)) return 'video';
  if (message.match(/\.(pdf|doc|docx|xls|xlsx)/i)) return 'document';
  // Also detect raw S3/media URLs without clear extension
  if (message.match(/^https?:\/\/.*manybot-files.*s3/i)) return 'image';
  return null;
}

// --- Venezuela Detection ---

function isVenezuela(phone) {
  if (!phone) return false;
  const cleaned = phone.replace(/[\s\-\(\)]/g, '');
  return cleaned.startsWith('+58') || cleaned.startsWith('58') || cleaned.startsWith('0058');
}

// --- Database Operations (Supabase) ---

async function getOrCreateUser(manychatId) {
  return withRetry(async () => {
    const users = await supabaseQuery(`wa_users?manychat_id=eq.${manychatId}&limit=1`);
    if (users && users.length > 0) return users[0];
    const now = new Date().toISOString();
    const newUsers = await supabaseQuery('wa_users', {
      method: 'POST',
      body: JSON.stringify({
        manychat_id: manychatId,
        funnel_stage: 'new_lead',
        first_contact: now,
        last_interaction: now,
        conversation_count: 0,
      }),
    });
    return newUsers && newUsers[0];
  }, { maxRetries: 2, label: 'getOrCreateUser' });
}

async function getConversationHistory(manychatId, limit = 20) {
  const messages = await supabaseQuery(
    `whatsapp_memoria?session_id=eq.${manychatId}&order=id.desc&limit=${limit}`
  );
  if (!messages || messages.length === 0) return [];
  return messages.reverse().map((msg) => ({
    role: msg.message.type === 'human' ? 'user' : 'assistant',
    content: msg.message.content,
  }));
}

async function saveMessage(manychatId, role, message) {
  await supabaseQuery('whatsapp_memoria', {
    method: 'POST',
    body: JSON.stringify({
      session_id: manychatId,
      message: {
        type: role === 'user' ? 'human' : 'ai',
        content: message,
        additional_kwargs: {},
        response_metadata: {},
      },
    }),
  });
}

async function updateUser(manychatId, updates) {
  const fields = { last_interaction: new Date().toISOString() };
  if (updates) {
    if (updates.phone) fields.phone = updates.phone;
    if (updates.name) fields.name = updates.name;
    if (updates.email) fields.email = updates.email;
    if (updates.funnel_stage) fields.funnel_stage = updates.funnel_stage;
    if (updates.origen) fields.origen = updates.origen;
  }
  await supabaseQuery(`wa_users?manychat_id=eq.${manychatId}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
}

// --- Prompt Assembly ---

function buildSystemPrompt(user, phone) {
  // Flujo nuevo (capturar nombre+correo -> entregar libro/grupo/curso): se cargan
  // solo sistema + flujo + config + contexto + crisis. El banco/libro-nina/apego-detox
  // del flujo viejo de venta ya NO se cargan.
  const sistema = loadPrompt('00_sistema_paula.md');
  const flujos = loadPrompt('04_flujos_conversacion.md');
  const config = loadPrompt('05_config_dinamica.md');
  const crisis = loadPrompt('03_protocolo_crisis.md');
  const userContext = buildUserContext(user, phone);

  return `${sistema}

---

# CONTEXTO DE ESTA USUARIA
${userContext}

---

# FLUJO DE CONVERSACION (SEGUIR PASO A PASO)
${flujos}

---

# CONFIGURACION (LINKS Y DATOS)
${config}

---

# PROTOCOLO DE CRISIS (PRIORIDAD MAXIMA)
${crisis}`;
}

function buildUserContext(user, phone) {
  const lines = [];
  if (user.name) {
    lines.push(`- Nombre: ${user.name}`);
  } else {
    lines.push('- Nombre: NO LO SABEMOS TODAVIA -- preguntarlo (Paso 1)');
  }
  if (user.email) {
    lines.push(`- Correo: ${user.email}`);
  } else {
    lines.push('- Correo: NO LO TENEMOS TODAVIA -- pedirlo (Paso 2)');
  }
  if (user.funnel_stage === 'libro_enviado') {
    lines.push('- LIBRO/EMBUDO YA ENVIADO: SI. NO volver a pedir nombre ni correo, NO repetir la marca [[LEAD]]. Solo acompanar y, si pregunta, reenviar el link del grupo o del curso.');
  } else {
    lines.push('- Libro/embudo enviado: NO -- objetivo: capturar nombre + correo y emitir [[LEAD: ...]]');
  }
  lines.push(`- Mensajes intercambiados: ${user.conversation_count}`);
  if (user.situacion_resumen) {
    lines.push(`- Resumen de su situacion: ${user.situacion_resumen}`);
  }
  if (isVenezuela(phone)) {
    lines.push('- Pais: VENEZUELA -- NO ofrecer programa de terapia 3 Citas Psicologicas');
  }
  return lines.join('\n');
}

// --- OpenRouter API Call ---

async function callOpenRouter(systemPrompt, messages) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY no esta configurada');
  const model = process.env.PAULA_MODEL || 'openai/gpt-4.1';
  return withRetry(async () => {
    const response = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://historiasdelamente.com',
        'X-Title': 'Paula - Historias de la Mente',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        max_tokens: 1024,
        temperature: 0.7,
      }),
      timeoutMs: 30000,
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenRouter error (${response.status}): ${error}`);
    }
    const data = await response.json();
    return data.choices[0]?.message?.content || '';
  }, { maxRetries: 2, baseDelay: 2000, label: 'callOpenRouter' });
}

// --- Main Entry Point ---

async function processPaulaMessage(manychatId, userMessage, replyType, phone) {
  replyType = replyType || 'text';
  phone = phone || '';

  // Handle media messages (audio, image, video, etc.)
  if (isMediaReply(replyType)) {
    const mediaResponse = MEDIA_RESPONSES[replyType];
    await saveMessage(manychatId, 'user', `[${replyType}]`);
    await saveMessage(manychatId, 'assistant', mediaResponse);
    await updateUser(manychatId, { phone });
    return mediaResponse;
  }

  // Detect media URLs in text (ManyChat sends image/audio URLs as text)
  const detectedMedia = detectMediaInText(userMessage);
  if (detectedMedia && MEDIA_RESPONSES[detectedMedia]) {
    const mediaResponse = MEDIA_RESPONSES[detectedMedia];
    await saveMessage(manychatId, 'user', `[${detectedMedia}]`);
    await saveMessage(manychatId, 'assistant', mediaResponse);
    await updateUser(manychatId, { phone });
    return mediaResponse;
  }

  // If no text message, ask for text
  if (!userMessage || userMessage.trim() === '') {
    const fallback = 'Recibi tu mensaje pero no pude leer el contenido. Me lo escribes en texto? Asi puedo ayudarte mejor \uD83D\uDC9B';
    await saveMessage(manychatId, 'user', '[mensaje sin texto]');
    await saveMessage(manychatId, 'assistant', fallback);
    await updateUser(manychatId, { phone });
    return fallback;
  }

  const user = await getOrCreateUser(manychatId);
  const history = await getConversationHistory(manychatId, 20);
  const systemPrompt = buildSystemPrompt(user, phone);
  const messages = [...history, { role: 'user', content: userMessage }];
  let paulaResponse = await callOpenRouter(systemPrompt, messages);

  // --- Captura de lead + disparo del embudo (determinista) ---
  // Si la IA marco [[LEAD: ...]] y aun no se ha enviado el libro, disparamos el
  // endpoint del sitio. funnel_stage='libro_enviado' (columna existente) hace de
  // candado anti-duplicado. La marca se borra SIEMPRE antes de responder.
  if (user.funnel_stage !== 'libro_enviado') {
    const lead = parseLeadTag(paulaResponse);
    if (lead) {
      try {
        await withRetry(
          () => enviarLeadCaptura({ nombre: lead.nombre, email: lead.email, origen: user.origen }),
          { maxRetries: 2, baseDelay: 2000, label: 'enviarLeadCaptura' }
        );
        // Candado anti-duplicado en columnas que sabemos existen.
        await updateUser(manychatId, { name: lead.nombre, funnel_stage: 'libro_enviado' });
        user.funnel_stage = 'libro_enviado';
        // El correo es best-effort: si la columna 'email' no existe, no rompe el flujo.
        try { await updateUser(manychatId, { email: lead.email }); }
        catch (e) { console.warn('[Paula] correo no persistido (columna email?):', e.message); }
      } catch (err) {
        console.error('[Paula] captura de lead fallo:', err.message);
      }
    }
  }

  paulaResponse = stripLeadTag(paulaResponse);

  await saveMessage(manychatId, 'user', userMessage);
  await saveMessage(manychatId, 'assistant', paulaResponse);
  await updateUser(manychatId, { phone });
  return paulaResponse;
}

// --- MarketingDetox Bridge ---

async function getPersonalizedRecommendations(user, detectedTopics) {
  const marketingUrl = process.env.MARKETING_DETOX_URL;
  const apiKey = process.env.MARKETING_DETOX_API_KEY;
  if (!marketingUrl || !apiKey) return null;

  try {
    const response = await fetchWithTimeout(`${marketingUrl}/api/paula/recommend`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        user_profile: {
          manychat_id: user.manychat_id,
          name: user.name,
          funnel_stage: user.funnel_stage,
          conversation_count: user.conversation_count,
          situacion_resumen: user.situacion_resumen,
          detected_topics: detectedTopics,
        },
        detected_topics: detectedTopics,
      }),
      timeoutMs: 5000,
    });

    if (!response.ok) return null;
    const data = await response.json();
    return data.recommendations || null;
  } catch {
    return null;
  }
}

// Simple topic detection from conversation
function detectTopics(message) {
  const topics = [];
  const text = message.toLowerCase();
  if (text.match(/narcis|narc|manipula|gasligh/)) topics.push('narcisismo');
  if (text.match(/apego|aferra|depen|no puedo dejarlo/)) topics.push('apego');
  if (text.match(/trauma|bond|adicci|regresar|volver con/)) topics.push('trauma_bonding');
  if (text.match(/ni[ñn]a interior|infancia|mama|papa|herida/)) topics.push('nina_interior');
  if (text.match(/sanar|salir|superar|recuperar|nueva vida/)) topics.push('sanacion');
  if (text.match(/crisis|no puedo mas|quiero morir|auxilio/)) topics.push('crisis');
  return topics;
}

module.exports = { processPaulaMessage, getPersonalizedRecommendations, detectTopics };
