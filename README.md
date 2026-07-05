# Paula — Cerradora de Apego Detox (WhatsApp + Instagram vía ManyChat)

> Rediseño 2026-07-04. Paula tiene UN solo objetivo: cerrar la venta de **Apego Detox**
> ($37.97 USD/mes — https://historiasdelamente.com/apegodetox). El embudo viejo
> (libro gratis + grupo + curso de YouTube + test) fue retirado de este canal.

## Cómo funciona

```
TikTok live ─┐
Instagram ───┤→ ManyChat → POST /webhook → Paula (OpenRouter gpt-4.1)
Anuncios ────┘                              ├─ valida el dolor → prescribe → cierra
                                            ├─ Supabase: wa_users + whatsapp_memoria
                                            └─ responde vía ManyChat API (canal correcto)

n8n / cron (cada 2h) → GET /cron/followup → recordatorios de compra (máx 2)
```

## Etapas de la usuaria (`wa_users.funnel_stage`)

| Etapa | Cómo se entra | Qué hace Paula |
|---|---|---|
| `new_lead` | primer mensaje | valida dolor → prescribe → cierra |
| `link_enviado` | Paula entregó link (detección automática) | descubre la objeción y vuelve a cerrar; no repite link |
| `compradora` | ella dice "ya pagué" (regex + marca `[[COMPRA]]`) | post-venta: acceso, clases, WhatsApp de Javier. Cero venta |
| `no_molestar` | ella pide no recibir mensajes (regex + `[[NO_MOLESTAR]]`) | se despide con respeto; sin recordatorios |

## Recordatorios de compra (followup.js)

- **R1** a las ≥4h de silencio · **R2** a las ≥16h (con link de pago + clase en vivo + garantía).
- Solo dentro de la **ventana de 24h** de WhatsApp (desde su último mensaje).
- Solo de **8 am a 9 pm hora Colombia**.
- Nunca a `compradora`, `no_molestar`, ni conversaciones que pasaron por **protocolo de crisis**.
- Cron recomendado: **cada 2 horas** (n8n-followup-workflow.json ya viene así).

## Configurar ManyChat (unificar WhatsApp + Instagram)

En AMBAS automatizaciones (WhatsApp y Instagram), la External Request a `POST /webhook` debe mandar:

```json
{
  "user_id": "{{subscriber_id}}",
  "user_message": "{{last_input_text}}",
  "phone": "{{phone}}",
  "canal": "whatsapp",        ← "instagram" en la automatización de IG
  "origen": "tiktok_live"     ← o "instagram", "anuncio_meta", etc. (custom field)
}
```

- `canal` decide por dónde responde Paula (WhatsApp o Instagram DM). Si falta, asume WhatsApp.
- `origen` le dice a Paula de dónde viene la mujer para adaptar la apertura. Opcional.

## Deploy (EasyPanel)

1. Correr `migrations.sql` UNA vez en el SQL Editor del Supabase de Paula (idempotente).
2. Push a `master` de este repo → EasyPanel → **Implementar** (rebuild del contenedor).
3. Verificar salud: `GET /` debe responder `"objetivo": "venta Apego Detox"`.
4. (Si usas n8n) Reimportar `n8n-followup-workflow.json` o cambiar el schedule a cada 2h.

Variables de entorno (sin cambios): `OPENROUTER_API_KEY`, `PAULA_MODEL` (default `openai/gpt-4.1`),
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `MANYCHAT_API_TOKEN`, `PORT`.
`WEB_BASE_URL` ya no se usa (el embudo del libro se retiró).

## Dónde se edita qué

| Quiero cambiar… | Archivo |
|---|---|
| Links, precio, horarios de clase | `prompts/05_config_dinamica.md` (y los copys de `followup.js` si aplica) |
| Personalidad / reglas de venta | `prompts/00_sistema_paula.md` |
| El paso a paso del cierre | `prompts/04_flujos_conversacion.md` |
| Datos del producto | `prompts/07_apego_detox.md` |
| Objeciones y FAQ | `prompts/02_banco_respuestas.md` |
| Textos de los recordatorios | `followup.js` (funciones `copyRecordatorio1/2`) |

Los prompts se recargan solos cada 5 minutos (sin redeploy). El código sí requiere Implementar.
