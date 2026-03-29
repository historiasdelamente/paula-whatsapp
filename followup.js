// --- Follow-up automático post-clase ---
// Este módulo revisa usuarios que recibieron el link de clase
// y no han respondido, y les envía un follow-up por ManyChat API.

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

async function sendWhatsAppMessage(subscriberId, text) {
  const token = process.env.MANYCHAT_API_TOKEN;
  if (!token) throw new Error('MANYCHAT_API_TOKEN no configurado');

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
          messages: [{ type: 'text', text }],
        },
      },
    }),
  });

  const data = await response.json();
  if (data.status !== 'success') {
    throw new Error(`ManyChat error: ${JSON.stringify(data)}`);
  }
  return data;
}

async function runFollowUp() {
  console.log('[FollowUp] Iniciando revisión...');

  // Get all users from wa_users
  const users = await supabaseQuery('wa_users?select=manychat_id,name,funnel_stage,last_interaction,followup_sent,followup2_sent');

  if (!users || users.length === 0) {
    console.log('[FollowUp] No hay usuarios.');
    return { checked: 0, sent: 0 };
  }

  const now = new Date();
  let sent = 0;

  for (const user of users) {
    try {
      // Get last messages for this user
      const messages = await supabaseQuery(
        `whatsapp_memoria?session_id=eq.${user.manychat_id}&order=id.desc&limit=5`
      );

      if (!messages || messages.length === 0) continue;

      // Check if we sent the class link
      const sentClassLink = messages.some(m =>
        m.message.type === 'ai' &&
        m.message.content.includes('historiasdelamente.com/clase-gratuita')
      );

      if (!sentClassLink) continue;

      // Find when the last message was
      const lastMsg = messages[0];
      const lastMsgTime = new Date(lastMsg.created_at || now);
      const hoursSinceLastMsg = (now - lastMsgTime) / (1000 * 60 * 60);

      // Check if last message was from Paula (user hasn't responded)
      const lastWasFromPaula = lastMsg.message.type === 'ai';

      if (!lastWasFromPaula) continue; // User already responded, no need for follow-up

      const nombre = user.name || '';

      // Follow-up 1: 24 hours after last interaction
      if (hoursSinceLastMsg >= 24 && hoursSinceLastMsg < 48 && !user.followup_sent) {
        const msg = nombre
          ? `${nombre}, pudiste ver la clase de Javier? Me encantaria saber que te parecio 💛`
          : `Hola! Pudiste ver la clase de Javier? Me encantaria saber que te parecio 💛`;

        await sendWhatsAppMessage(user.manychat_id, msg);
        await supabaseQuery(`wa_users?manychat_id=eq.${user.manychat_id}`, {
          method: 'PATCH',
          body: JSON.stringify({ followup_sent: true }),
        });

        // Save in conversation history
        await supabaseQuery('whatsapp_memoria', {
          method: 'POST',
          body: JSON.stringify({
            session_id: user.manychat_id,
            message: { type: 'ai', content: msg, additional_kwargs: {}, response_metadata: {} },
          }),
        });

        console.log(`[FollowUp] Enviado followup 1 a ${user.manychat_id} (${nombre})`);
        sent++;
      }

      // Follow-up 2: 48 hours after last interaction
      if (hoursSinceLastMsg >= 48 && user.followup_sent && !user.followup2_sent) {
        const msg = nombre
          ? `${nombre}, solo queria saber como estas. Este espacio sigue aqui cuando lo necesites ✨`
          : `Solo queria saber como estas. Este espacio sigue aqui cuando lo necesites ✨`;

        await sendWhatsAppMessage(user.manychat_id, msg);
        await supabaseQuery(`wa_users?manychat_id=eq.${user.manychat_id}`, {
          method: 'PATCH',
          body: JSON.stringify({ followup2_sent: true }),
        });

        await supabaseQuery('whatsapp_memoria', {
          method: 'POST',
          body: JSON.stringify({
            session_id: user.manychat_id,
            message: { type: 'ai', content: msg, additional_kwargs: {}, response_metadata: {} },
          }),
        });

        console.log(`[FollowUp] Enviado followup 2 a ${user.manychat_id} (${nombre})`);
        sent++;
      }

    } catch (err) {
      console.error(`[FollowUp] Error con ${user.manychat_id}:`, err.message);
    }
  }

  console.log(`[FollowUp] Revisados: ${users.length}, Enviados: ${sent}`);
  return { checked: users.length, sent };
}

module.exports = { runFollowUp };
