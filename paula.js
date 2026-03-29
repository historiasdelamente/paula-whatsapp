const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// --- Database Setup ---

const DB_PATH = path.join(__dirname, 'data', 'paula.db');

// Ensure data directory exists
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS wa_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    manychat_id TEXT UNIQUE NOT NULL,
    name TEXT,
    funnel_stage TEXT DEFAULT 'new_lead',
    situacion_resumen TEXT,
    first_contact TEXT DEFAULT (datetime('now')),
    last_interaction TEXT DEFAULT (datetime('now')),
    conversation_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS wa_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    message TEXT NOT NULL,
    phase TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

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

// Clear cache every 5 minutes (so prompt edits take effect)
setInterval(() => {
  Object.keys(promptCache).forEach(k => delete promptCache[k]);
}, 5 * 60 * 1000);

// --- Database Operations ---

function getOrCreateUser(manychatId) {
  let user = db.prepare('SELECT * FROM wa_users WHERE manychat_id = ?').get(manychatId);

  if (!user) {
    db.prepare('INSERT INTO wa_users (manychat_id, funnel_stage) VALUES (?, ?)').run(manychatId, 'new_lead');
    user = db.prepare('SELECT * FROM wa_users WHERE manychat_id = ?').get(manychatId);
  }

  return user;
}

function getConversationHistory(manychatId, limit = 20) {
  return db.prepare(
    'SELECT * FROM wa_conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(manychatId, limit);
}

function saveMessage(manychatId, role, message, phase) {
  db.prepare(
    'INSERT INTO wa_conversations (user_id, role, message, phase) VALUES (?, ?, ?, ?)'
  ).run(manychatId, role, message, phase || null);
}

function updateUser(manychatId) {
  db.prepare(
    "UPDATE wa_users SET last_interaction = datetime('now'), conversation_count = conversation_count + 1 WHERE manychat_id = ?"
  ).run(manychatId);
}

// --- Prompt Assembly ---

function buildSystemPrompt(user) {
  const sistema = loadPrompt('00_sistema_paula.md');
  const banco = loadPrompt('02_banco_respuestas.md');
  const crisis = loadPrompt('03_protocolo_crisis.md');
  const config = loadPrompt('05_config_dinamica.md');

  const userContext = buildUserContext(user);

  return `${sistema}

---

# CONTEXTO DE ESTA USUARIA
${userContext}

---

# CONFIGURACIÓN ACTUAL
${config}

---

# BANCO DE RESPUESTAS (FAQ)
${banco}

---

# PROTOCOLO DE CRISIS (PRIORIDAD MÁXIMA)
${crisis}`;
}

function buildUserContext(user) {
  const lines = [];

  if (user.name) {
    lines.push(`- Nombre: ${user.name}`);
  } else {
    lines.push('- Nombre: NO LO SABEMOS TODAVÍA — preguntarlo');
  }

  lines.push(`- Etapa del funnel: ${user.funnel_stage}`);
  lines.push(`- Mensajes intercambiados: ${user.conversation_count}`);
  lines.push(`- Primer contacto: ${user.first_contact}`);

  if (user.situacion_resumen) {
    lines.push(`- Resumen de su situación: ${user.situacion_resumen}`);
  }

  return lines.join('\n');
}

function buildMessages(history, currentMessage) {
  const chronological = [...history].reverse();
  const messages = [];

  for (const msg of chronological) {
    messages.push({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.message,
    });
  }

  messages.push({ role: 'user', content: currentMessage });
  return messages;
}

// --- OpenRouter API Call ---

async function callOpenRouter(systemPrompt, messages) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY no está configurada');
  }

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
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
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

async function processPaulaMessage(manychatId, userMessage) {
  const user = getOrCreateUser(manychatId);
  const history = getConversationHistory(manychatId, 20);
  const systemPrompt = buildSystemPrompt(user);
  const messages = buildMessages(history, userMessage);

  const paulaResponse = await callOpenRouter(systemPrompt, messages);

  saveMessage(manychatId, 'user', userMessage);
  saveMessage(manychatId, 'assistant', paulaResponse);
  updateUser(manychatId);

  return paulaResponse;
}

module.exports = { processPaulaMessage };
