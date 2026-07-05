// --- Recordatorios de compra APEGO DETOX ---
// Revisa conversaciones que quedaron en silencio y envía hasta 2 recordatorios
// para cerrar la venta. Reemplaza el follow-up viejo del test de dependencia
// emocional (retirado 2026-07-04).
//
// Reglas duras:
//   - Nunca a compradoras ni a quien pidió no_molestar.
//   - Nunca si la conversación pasó por protocolo de crisis.
//   - Solo dentro de la ventana de 24h de WhatsApp (desde su último mensaje).
//   - Solo en horario prudente Colombia (8 am - 9 pm).
//   - Recordatorio 1: ≥4h de silencio. Recordatorio 2: ≥16h de silencio.

const { withRetry, fetchWithTimeout } = require('./utils');

const CHECKOUT_URL = 'https://pay.hotmart.com/W102751360L?bid=1771690985611';
const LANDING_URL = 'https://historiasdelamente.com/apegodetox';

// Marcadores que indican que la conversación pasó por protocolo de crisis
// (respuestas de Paula en nivel 1 — líneas de ayuda — y nivel 2 — violencia)
const CRISIS_MARKERS_AI = [
  'línea 106', 'linea 106', '800-911-2000', '717-003-717', '600-360-7777', '273-8026',
  'línea de crisis', 'linea de crisis', 'líneas gratuitas', 'lineas gratuitas',
  'línea de la mujer', 'linea de la mujer', 'llama a emergencias',
];
// Frases de crisis dichas por ELLA (alto valor de señal, sin falsos positivos fáciles)
const CRISIS_MARKERS_HUMAN = [
  'me quiero morir', 'quiero morirme', 'no quiero vivir', 'quiero desaparecer',
  'hacerme daño', 'suicid', 'me golpea', 'me pega', 'me amenaza',
];

async function supabaseQuery(endpoint, options = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const headers = {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  if (options.method === 'POST') headers['Prefer'] = 'return=representation';
  if (options.method === 'PATCH') headers['Prefer'] = 'return=representation';

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

async function sendManyChatMessage(subscriberId, text, canal) {
  const token = process.env.MANYCHAT_API_TOKEN;
  if (!token) throw new Error('MANYCHAT_API_TOKEN no configurado');

  const contentType = String(canal || '').toLowerCase() === 'instagram' ? 'instagram' : 'whatsapp';
  // Mismo formato que server.js: línea en blanco = globo aparte
  const parts = String(text).split(/\n\n/).filter(p => p.trim());
  const messages = parts.map(p => ({ type: 'text', text: p.trim() }));

  return withRetry(async () => {
    const response = await fetchWithTimeout('https://api.manychat.com/fb/sending/sendContent', {
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
            type: contentType,
            messages,
          },
        },
      }),
      timeoutMs: 10000,
    });

    const data = await response.json();
    if (data.status !== 'success') {
      throw new Error(`ManyChat error: ${JSON.stringify(data)}`);
    }
    return data;
  }, { maxRetries: 3, baseDelay: 1000, label: 'sendFollowUp' });
}

// Hora local Colombia (UTC-5, sin horario de verano)
function horaColombia(date) {
  return (date.getUTCHours() - 5 + 24) % 24;
}

// --- Copys de los recordatorios ---
// Variante determinista por manychat_id para que no todas reciban lo mismo.

function pick(variants, seedStr) {
  let h = 0;
  const s = String(seedStr);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return variants[h % variants.length];
}

function saludo(nombre) {
  return nombre ? `${nombre}, ` : '';
}

// Sin nombre, los copys arrancarían en minúscula ("soy Paula…") — capitalizar.
function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Recordatorio 1 (≥4h): retomar el hilo. Si ya tiene el link, preguntar qué la frena.
function copyRecordatorio1(nombre, linkYaEnviado) {
  const n = saludo(nombre);
  if (linkYaEnviado) {
    return cap(pick([
      `${n}soy Paula 💛 ¿Pudiste ver lo de Apego Detox? Te lo mandé porque encaja exacto con lo que me contaste.\n\nSi algo te frena, dímelo y lo resolvemos juntas. ¿Qué es lo que más te detiene?`,
      `${n}me quedé pensando en ti 💛 El programa que te mandé trabaja justo eso que me contaste — no es consuelo, es proceso.\n\n¿Qué te detuvo? Cuéntame y lo vemos sin presión.`,
    ], nombre + '1'));
  }
  return cap(pick([
    `${n}soy Paula 💛 Me quedé pensando en lo que me contaste. Eso que vives tiene nombre y tiene salida — y no es a punta de fuerza de voluntad.\n\nJavier creó un programa exacto para esto. Míralo con calma: ${LANDING_URL} ¿Te cuento cómo funciona?`,
    `${n}te escribo porque lo que me contaste no se me olvidó 💛 No estás rota: tu sistema quedó enganchado, y eso se reentrena.\n\nEste es el proceso de Javier para salir de ahí: ${LANDING_URL} ¿Quieres que te cuente cómo es por dentro?`,
  ], nombre + '1'));
}

// Recordatorio 2 (≥16h): ancla honesta — clase en vivo + garantía + link de pago.
function copyRecordatorio2(nombre) {
  const n = saludo(nombre);
  return cap(pick([
    `${n}esta semana hay clase en vivo con Javier (martes y jueves, 8 pm hora Colombia). Si entras hoy, llegas con acceso a todo: ${CHECKOUT_URL}\n\nSon $37.97 al mes, cancelas cuando quieras y tienes 7 días de garantía total. Un mes de proceso puede ser el primer mes en años que tu cabeza descansa 💛`,
    `${n}no te escribo para presionarte — te escribo porque sé cómo pesa cada semana más dentro del bucle 💛 La próxima clase en vivo con Javier es martes y jueves a las 8 pm (Colombia).\n\nEntras aquí, con 7 días de garantía y cancelas cuando quieras: ${CHECKOUT_URL} ✨`,
  ], nombre + '2'));
}

async function runFollowUp() {
  console.log('[FollowUp] Iniciando revisión (recordatorios Apego Detox)...');

  // select=* para tolerar schemas con/sin columnas opcionales (email, origen, canal)
  const users = await supabaseQuery('wa_users?select=*');

  if (!users || users.length === 0) {
    console.log('[FollowUp] No hay usuarios.');
    return { checked: 0, sent: 0 };
  }

  const now = new Date();
  const hora = horaColombia(now);
  if (hora < 8 || hora >= 21) {
    console.log(`[FollowUp] Fuera de horario prudente Colombia (${hora}h). No se envía nada.`);
    return { checked: users.length, sent: 0, skipped: 'quiet_hours' };
  }

  let sent = 0;

  for (const user of users) {
    try {
      const stage = user.funnel_stage || 'new_lead';
      if (stage === 'compradora' || stage === 'no_molestar') continue;
      if (user.followup_sent && user.followup2_sent) continue;

      // Últimos mensajes de esta conversación
      const messages = await supabaseQuery(
        `whatsapp_memoria?session_id=eq.${user.manychat_id}&order=id.desc&limit=12`
      );
      if (!messages || messages.length < 2) continue; // hubo poca o nula conversación

      // Nunca recordar venta a una conversación que pasó por crisis
      const huboCrisis = messages.some(m => {
        if (!m.message) return false;
        const c = (m.message.content || '').toLowerCase();
        if (m.message.type === 'ai') return CRISIS_MARKERS_AI.some(k => c.includes(k));
        return CRISIS_MARKERS_HUMAN.some(k => c.includes(k));
      });
      if (huboCrisis) continue;

      // whatsapp_memoria puede no tener created_at (tabla estilo n8n).
      // Fallback: wa_users.last_interaction — solo se actualiza cuando ELLA
      // escribe (los recordatorios no la tocan), así que aproxima bien.
      const fallbackTime = user.last_interaction ? new Date(user.last_interaction) : now;

      // Silencio total (último mensaje de cualquiera de las dos)
      const lastMsgTime = messages[0].created_at ? new Date(messages[0].created_at) : fallbackTime;
      const hoursSinceLastMsg = (now - lastMsgTime) / (1000 * 60 * 60);

      // Ventana de 24h de WhatsApp: desde el último mensaje de ELLA
      const lastHuman = messages.find(m => m.message && m.message.type === 'human');
      if (!lastHuman) continue;
      const lastHumanTime = lastHuman.created_at ? new Date(lastHuman.created_at) : fallbackTime;
      const hoursSinceHuman = (now - lastHumanTime) / (1000 * 60 * 60);
      if (hoursSinceHuman >= 23.5) continue; // ventana cerrada — no se puede enviar

      const linkYaEnviado = stage === 'link_enviado' || messages.some(m =>
        m.message && m.message.type === 'ai' &&
        ((m.message.content || '').includes('apegodetox') || (m.message.content || '').includes('hotmart'))
      );

      let msg = null;
      let patch = null;

      if (!user.followup_sent && hoursSinceLastMsg >= 4) {
        msg = copyRecordatorio1(user.name, linkYaEnviado);
        patch = { followup_sent: true };
      } else if (user.followup_sent && !user.followup2_sent && hoursSinceLastMsg >= 16 && hoursSinceHuman >= 16) {
        msg = copyRecordatorio2(user.name);
        patch = { followup2_sent: true };
      }

      if (!msg) continue;

      // Marcar ANTES de enviar: si el PATCH falla no se envía nada (se
      // reintenta al próximo cron); si el envío falla tras marcar, se pierde
      // ese recordatorio — preferible a repetírselo cada 2 horas.
      await supabaseQuery(`wa_users?manychat_id=eq.${user.manychat_id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      await sendManyChatMessage(user.manychat_id, msg, user.canal);

      // Guardar en el historial para que Paula tenga el contexto si ella responde
      await supabaseQuery('whatsapp_memoria', {
        method: 'POST',
        body: JSON.stringify({
          session_id: user.manychat_id,
          message: { type: 'ai', content: msg, additional_kwargs: {}, response_metadata: {} },
        }),
      });

      console.log(`[FollowUp] Enviado a ${user.manychat_id} (${user.name || 'sin nombre'}) [${Object.keys(patch)[0]}]`);
      sent++;

    } catch (err) {
      console.error(`[FollowUp] Error con ${user.manychat_id}:`, err.message);
    }
  }

  console.log(`[FollowUp] Revisados: ${users.length}, Enviados: ${sent}`);
  return { checked: users.length, sent };
}

module.exports = { runFollowUp };
