const fs = require('fs');
const path = require('path');
const { withRetry, fetchWithTimeout } = require('./utils');

// ============================================================================
// PAULA — CERRADORA DE APEGO DETOX
// Flujo único de venta: conectar con el dolor -> prescribir Apego Detox ->
// cerrar. El embudo viejo (libro gratis + grupo + curso via /api/leads/capture)
// fue RETIRADO por decisión de negocio (2026-07-04).
//
// Etapas (wa_users.funnel_stage):
//   new_lead      -> conversando, aún sin link
//   link_enviado  -> Paula ya entregó el link (pago o landing)
//   compradora    -> ella confirmó la compra (modo post-venta, cero venta)
//   no_molestar   -> pidió no recibir más mensajes (sin follow-ups)
// Valores legacy ('libro_enviado' del embudo viejo) se tratan como new_lead.
// ============================================================================

// Links canon (mismos que la landing desing_web — si cambian allá, cambiar acá
// y en prompts/05_config_dinamica.md).
const CHECKOUT_MARKER = 'pay.hotmart.com/W102751360L';
const LANDING_MARKER = 'historiasdelamente.com/apegodetox';

// --- Marcas ocultas que emite la IA (el sistema las borra antes de responder) ---
const COMPRA_TAG_RE = /\[\[\s*COMPRA\s*\]\]/gi;
const NO_MOLESTAR_TAG_RE = /\[\[\s*NO_MOLESTAR\s*\]\]/gi;
// La marca [[LEAD]] del embudo viejo ya no dispara nada, pero se sigue borrando
// por si el modelo la emite por inercia del historial.
const LEGACY_LEAD_TAG_RE = /\[\[\s*LEAD:[^\]]*\]\]/gi;

function stripHiddenTags(text) {
  return (text || '')
    .replace(COMPRA_TAG_RE, '')
    .replace(NO_MOLESTAR_TAG_RE, '')
    .replace(LEGACY_LEAD_TAG_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- Detección determinista en el mensaje de ELLA (no depende del LLM) ---

// "ya pagué", "acabo de comprar", "ya me inscribí", "ya hice el pago"...
// OJO: sin \b al final — en JS \b falla tras vocales acentuadas ("pagué", "inscribí").
const COMPRA_USER_RE = /\b(ya\s+(pagu[eé]|compr[eé]|me\s+inscrib[ií])|acabo\s+de\s+(pagar|comprar|inscribirme)|ya\s+hice\s+el\s+pago|ya\s+estoy\s+(dentro|inscrita))/i;

// "no me escribas más", "deja de escribirme", "bórrame"...
const NO_MOLESTAR_USER_RE = /(no\s+me\s+escriba[sn]\s+m[aá]s|no\s+me\s+escriba[sn]\b|deja\s+de\s+escribirme|dejen\s+de\s+escribirme|no\s+quiero\s+(m[aá]s\s+)?mensajes|no\s+me\s+contacten|b[oó]rrame|qu[ií]tame\s+de\s+(la\s+)?lista)/i;

// Correo suelto en el mensaje (solo para guardarlo como dato de contacto;
// ya NO dispara ningún embudo).
function extractEmail(text) {
  if (!text) return null;
  const m = String(text).match(/[^\s@]+@[^\s@]+\.[^\s@]{2,}/);
  return m ? m[0].trim().toLowerCase() : null;
}

// Heurística conservadora de nombre (para personalizar chat y follow-ups).
// Acepta 1-3 palabras alfabéticas; descarta saludos/keywords comunes.
const NOMBRE_STOP = new Set([
  'hola', 'holi', 'buenas', 'buenos', 'si', 'sí', 'no', 'ok', 'okey', 'okay',
  'vale', 'claro', 'gracias', 'quiero', 'libro', 'ayuda', 'info', 'informacion',
  'información', 'dale', 'listo', 'bueno', 'bien', 'mal', 'hey', 'que', 'qué',
  'como', 'cómo', 'tu', 'tú', 'curso', 'grupo', 'correo', 'precio', 'pago',
  'link', 'programa', 'detox', 'apego',
]);
function guessName(text) {
  if (!text) return null;
  const t = String(text).trim();
  if (!t || t.includes('@')) return null;
  if (!/^[a-zà-ÿñ' .-]{2,40}$/i.test(t)) return null;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 3) return null;
  if (words.some((w) => NOMBRE_STOP.has(w.toLowerCase()))) return null;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
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
  audio: 'No puedo escuchar audios por aqui, pero me encantaria leerte. Me escribes lo que querias decirme? 💛',
  image: 'Vi que me mandaste una imagen pero no puedo verla por aqui. Si necesitas contarme algo, escribemelo y te ayudo ✨',
  video: 'Recibi tu video pero no puedo reproducirlo por aqui. Me cuentas en texto lo que querias mostrarme? 💛',
  sticker: 'Recibi tu sticker 💛 Cuentame, como estas?',
  document: 'Recibi tu archivo pero no puedo abrirlo por aqui. Si necesitas algo, escribemelo y te ayudo ✨',
  location: 'Recibi tu ubicacion. Si necesitas algo, cuentame por texto y te ayudo 💛',
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

// PATCH en dos partes: los campos que seguro existen van juntos; los campos
// opcionales (email/origen/canal — pueden no existir como columna) van cada uno
// por separado en best-effort, para que un schema viejo nunca rompa el flujo.
async function updateUser(manychatId, updates) {
  const fields = { last_interaction: new Date().toISOString() };
  if (updates) {
    if (updates.phone) fields.phone = updates.phone;
    if (updates.name) fields.name = updates.name;
    if (updates.funnel_stage) fields.funnel_stage = updates.funnel_stage;
  }
  await supabaseQuery(`wa_users?manychat_id=eq.${manychatId}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });

  const optional = {};
  if (updates && updates.email) optional.email = updates.email;
  if (updates && updates.origen) optional.origen = updates.origen;
  if (updates && updates.canal) optional.canal = updates.canal;
  for (const [col, val] of Object.entries(optional)) {
    try {
      await supabaseQuery(`wa_users?manychat_id=eq.${manychatId}`, {
        method: 'PATCH',
        body: JSON.stringify({ [col]: val }),
      });
    } catch (e) {
      console.warn(`[Paula] columna opcional '${col}' no persistida:`, e.message);
    }
  }
}

async function setStage(manychatId, user, stage) {
  await updateUser(manychatId, { funnel_stage: stage });
  user.funnel_stage = stage;
}

// --- Prompt Assembly ---

function buildSystemPrompt(user, phone) {
  const sistema = loadPrompt('00_sistema_paula.md');
  const flujos = loadPrompt('04_flujos_conversacion.md');
  const config = loadPrompt('05_config_dinamica.md');
  const producto = loadPrompt('07_apego_detox.md');
  const banco = loadPrompt('02_banco_respuestas.md');
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

# BASE DE CONOCIMIENTO DEL PRODUCTO (APEGO DETOX)
${producto}

---

# BANCO DE RESPUESTAS (OBJECIONES Y FAQ)
${banco}

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
  if (user.origen) {
    lines.push(`- Origen: ${user.origen} (adapta la apertura a este canal)`);
  }

  const stage = user.funnel_stage || 'new_lead';
  if (stage === 'compradora') {
    lines.push('- ETAPA: COMPRADORA. Ya pagó Apego Detox. MODO POST-VENTA: cero venta, no mandes links de pago. Acompaña, resuelve dudas de acceso, recuerda las clases en vivo (martes y jueves 8 pm Colombia) y el WhatsApp de Javier si hay problemas de acceso.');
  } else if (stage === 'link_enviado') {
    lines.push('- ETAPA: LINK YA ENVIADO. No repitas el link salvo que ella lo pida. Tu foco ahora: descubrir qué la frena (pregunta directa) y resolver ESA objeción, luego cerrar de nuevo.');
  } else if (stage === 'no_molestar') {
    lines.push('- ETAPA: PIDIO NO RECIBIR MENSAJES. Si su ultimo mensaje es pedir que no le escribas, despidete con respeto en 1 solo mensaje, sin vender. Si volvio a escribir por su cuenta con otro tema, responde con suavidad, sin venta agresiva; si pregunta por el programa, retoma normal.');
  } else {
    lines.push('- ETAPA: EN CONVERSACION. Objetivo: validar su dolor, prescribir Apego Detox y cerrar la venta (ver flujo).');
  }

  lines.push(`- Mensajes intercambiados: ${user.conversation_count}`);
  if (user.situacion_resumen) {
    lines.push(`- Resumen de su situacion: ${user.situacion_resumen}`);
  }
  if (isVenezuela(phone)) {
    lines.push('- Pais: VENEZUELA -- si pregunta por terapia individual, NO ofrecerla. Solo Apego Detox.');
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

async function processPaulaMessage(manychatId, userMessage, replyType, phone, origen, canal) {
  replyType = replyType || 'text';
  phone = phone || '';
  origen = origen || '';
  canal = canal || '';

  // Handle media messages (audio, image, video, etc.)
  if (isMediaReply(replyType)) {
    const mediaResponse = MEDIA_RESPONSES[replyType];
    await saveMessage(manychatId, 'user', `[${replyType}]`);
    await saveMessage(manychatId, 'assistant', mediaResponse);
    await updateUser(manychatId, { phone, origen, canal });
    return mediaResponse;
  }

  // Detect media URLs in text (ManyChat sends image/audio URLs as text)
  const detectedMedia = detectMediaInText(userMessage);
  if (detectedMedia && MEDIA_RESPONSES[detectedMedia]) {
    const mediaResponse = MEDIA_RESPONSES[detectedMedia];
    await saveMessage(manychatId, 'user', `[${detectedMedia}]`);
    await saveMessage(manychatId, 'assistant', mediaResponse);
    await updateUser(manychatId, { phone, origen, canal });
    return mediaResponse;
  }

  // If no text message, ask for text
  if (!userMessage || userMessage.trim() === '') {
    const fallback = 'Recibi tu mensaje pero no pude leer el contenido. Me lo escribes en texto? Asi puedo ayudarte mejor 💛';
    await saveMessage(manychatId, 'user', '[mensaje sin texto]');
    await saveMessage(manychatId, 'assistant', fallback);
    await updateUser(manychatId, { phone, origen, canal });
    return fallback;
  }

  const user = await getOrCreateUser(manychatId);

  // --- Detección determinista ANTES del LLM (no depende del modelo) ---

  // Nombre (heurística) — para personalizar chat y recordatorios.
  if (!user.name) {
    const maybe = guessName(userMessage);
    if (maybe) {
      try { await updateUser(manychatId, { name: maybe }); user.name = maybe; }
      catch (e) { /* transitorio: se reintenta en el próximo mensaje */ }
    }
  }

  // Correo suelto — se guarda como dato de contacto (ya NO dispara embudos).
  const emailUsuaria = extractEmail(userMessage);
  if (emailUsuaria && !user.email) {
    try { await updateUser(manychatId, { email: emailUsuaria }); user.email = emailUsuaria; }
    catch (e) { /* best-effort */ }
  }

  // Confirmación de compra dicha por ella.
  if (user.funnel_stage !== 'compradora' && COMPRA_USER_RE.test(userMessage)) {
    try { await setStage(manychatId, user, 'compradora'); }
    catch (e) { console.error('[Paula] no se pudo marcar compradora:', e.message); }
  }

  // Pidió no recibir más mensajes.
  if (user.funnel_stage !== 'no_molestar' && NO_MOLESTAR_USER_RE.test(userMessage)) {
    try { await setStage(manychatId, user, 'no_molestar'); }
    catch (e) { console.error('[Paula] no se pudo marcar no_molestar:', e.message); }
  }

  const history = await getConversationHistory(manychatId, 20);
  const systemPrompt = buildSystemPrompt(user, phone);
  const messages = [...history, { role: 'user', content: userMessage }];
  let paulaResponse = await callOpenRouter(systemPrompt, messages);

  // --- Marcas de la IA (secundarias a la detección determinista) ---
  if (user.funnel_stage !== 'compradora' && COMPRA_TAG_RE.test(paulaResponse)) {
    try { await setStage(manychatId, user, 'compradora'); }
    catch (e) { console.error('[Paula] marca COMPRA fallo:', e.message); }
  }
  COMPRA_TAG_RE.lastIndex = 0;

  if (user.funnel_stage !== 'no_molestar' && user.funnel_stage !== 'compradora' && NO_MOLESTAR_TAG_RE.test(paulaResponse)) {
    try { await setStage(manychatId, user, 'no_molestar'); }
    catch (e) { console.error('[Paula] marca NO_MOLESTAR fallo:', e.message); }
  }
  NO_MOLESTAR_TAG_RE.lastIndex = 0;

  paulaResponse = stripHiddenTags(paulaResponse);

  // --- Detección determinista del link en la respuesta de Paula ---
  // Si entregó el checkout o la landing y ella aún no compró, pasa a link_enviado.
  const stage = user.funnel_stage || 'new_lead';
  const linkEntregado = paulaResponse.includes(CHECKOUT_MARKER) || paulaResponse.includes(LANDING_MARKER);
  if (linkEntregado && stage !== 'compradora' && stage !== 'no_molestar' && stage !== 'link_enviado') {
    try { await setStage(manychatId, user, 'link_enviado'); }
    catch (e) { console.error('[Paula] no se pudo marcar link_enviado:', e.message); }
  }

  await saveMessage(manychatId, 'user', userMessage);
  await saveMessage(manychatId, 'assistant', paulaResponse);
  await updateUser(manychatId, { phone, origen, canal });
  return paulaResponse;
}

module.exports = { processPaulaMessage };
