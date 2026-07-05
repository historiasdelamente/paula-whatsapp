// Standalone cron trigger for Paula follow-up (recordatorios Apego Detox).
//
// Correr cada 2 horas via:
//   - crontab: 0 0-23/2 * * * node /path/to/cron-followup.js
//   - n8n: HTTP Request node -> GET http://localhost:3000/cron/followup
//   - EasyPanel: scheduled task
//   - PM2: pm2 start cron-followup.js --cron "0 0-23/2 * * *"

const PAULA_URL = process.env.PAULA_URL || 'http://localhost:3000';

async function triggerFollowUp() {
  const timestamp = new Date().toISOString();
  console.log(`[Cron] ${timestamp} — Triggering follow-up...`);

  try {
    const response = await fetch(`${PAULA_URL}/cron/followup`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    const data = await response.json();
    console.log(`[Cron] Result:`, JSON.stringify(data));

    if (data.sent > 0) {
      console.log(`[Cron] ✅ ${data.sent} follow-ups enviados de ${data.checked} usuarios revisados`);
    } else {
      console.log(`[Cron] ℹ️ Sin follow-ups pendientes (${data.checked} usuarios revisados)`);
    }
  } catch (err) {
    console.error(`[Cron] ❌ Error:`, err.message);
    process.exit(1);
  }
}

triggerFollowUp();
