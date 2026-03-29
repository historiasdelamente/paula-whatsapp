const fs = require('fs');
const path = require('path');

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
  const response = await fetch(`${url}/rest/v1/${endpoint}`, {
    ...options,
    headers: { ...headers, ...options.headers },
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
  audio: 'No puedo escuchar audios por aqui, pero me encantaria leerte. Me escribes lo que querias decirme? \uD83D\uDDA4',
  image: 'Vi que me mandaste una imagen pero no puedo verla por aqui. Si necesitas contarme algo, escribemelo y te ayudo \u2728',
  video: 'Recibi tu video pero no puedo reproducirlo por aqui. Me cuentas en texto lo que querias mostrarme? \uD83D\uDDA4',
  sticker: 'Recibi tu sticker \uD83D\uDDA4 Cuentame, como estas?',
  document: 'Recibi tu archivo pero no puedo abrirlo por aqui. Si necesitas algo, escribemelo y te ayudo \u2728',
  location: 'Recibi tu ubicacion. Si necesitas algo, cuentame por texto y te ayudo \uD83D\uDDA4',
};

function isMediaReply(replyType) {
  return replyType && replyType !== 'text' && MEDIA_RESPONSES[replyType];
}

// --- Venezuela Detection ---

function isVenezuela(phone) {
  if (!phone) return false;
  const cleaned = phone.replace(/[\s\-\(\)]/g, '');
  return cleaned.startsWith('+58') || cleaned.startsWith('58') || cleaned.startsWith('0058');
}

// --- Database Operations (Supabase) ---

async function getOrCreateUser(manychatId) {
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
  if (updates && updates.phone) fields.phone = updates.phone;
  await supabaseQuery(`wa_users?manychat_id=eq.${manychatId}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
}

// --- Prompt Assembly ---

function buildSystemPrompt(user, phone) {
  const sistema = loadPrompt('00_sistema_paula.md');
  const banco = loadPrompt('02_banco_respuestas.md');
  const crisis = loadPrompt('03_protocolo_crisis.md');
  const config = loadPrompt('05_config_dinamica.md');
  const userContext = buildUserContext(user, phone);

  return `${sistema}

---

# CONTEXTO DE ESTA USUARIA
${userContext}

---

# CONFIGURACION ACTUAL
${config}

---

# BANCO DE RESPUESTAS (FAQ)
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
    lines.push('- Nombre: NO LO SABEMOS TODAVIA -- preguntarlo');
  }
  lines.push(`- Etapa del funnel: ${user.funnel_stage}`);
  lines.push(`- Mensajes intercambiados: ${user.conversation_count}`);
  lines.push(`- Primer contacto: ${user.first_contact}`);
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
  const model = process.env.PAULA_MODEL || 'openai/gpt-4.1-mini';
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
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
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter error (${response.status}): ${error}`);
  }
  const data = await response.json();
  return data.choices[0]?.message?.content || '';
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

  // If no text message, ask for text
  if (!userMessage || userMessage.trim() === '') {
    const fallback = 'Recibi tu mensaje pero no pude leer el contenido. Me lo escribes en texto? Asi puedo ayudarte mejor \uD83D\uDDA4';
    await saveMessage(manychatId, 'user', '[mensaje sin texto]');
    await saveMessage(manychatId, 'assistant', fallback);
    await updateUser(manychatId, { phone });
    return fallback;
  }

  const user = await getOrCreateUser(manychatId);
  const history = await getConversationHistory(manychatId, 20);
  const systemPrompt = buildSystemPrompt(user, phone);
  const messages = [...history, { role: 'user', content: userMessage }];
  const paulaResponse = await callOpenRouter(systemPrompt, messages);
  await saveMessage(manychatId, 'user', userMessage);
  await saveMessage(manychatId, 'assistant', paulaResponse);
  await updateUser(manychatId, { phone });
  return paulaResponse;
}

module.exports = { processPaulaMessage };
