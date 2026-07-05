-- ============================================================================
-- MIGRACIÓN — Paula vendedora de Apego Detox (2026-07-04)
-- Correr UNA vez en el SQL Editor del Supabase de Paula (el de wa_users).
-- Todo es idempotente: se puede correr de nuevo sin romper nada.
-- ============================================================================

-- 1) Columnas opcionales (el código funciona sin ellas, pero con ellas
--    Paula personaliza mejor y los recordatorios salen por el canal correcto).
ALTER TABLE wa_users ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE wa_users ADD COLUMN IF NOT EXISTS origen text;   -- tiktok_live | instagram | anuncio | ...
ALTER TABLE wa_users ADD COLUMN IF NOT EXISTS canal text;    -- whatsapp | instagram (transporte ManyChat)
ALTER TABLE wa_users ADD COLUMN IF NOT EXISTS followup_sent boolean DEFAULT false;
ALTER TABLE wa_users ADD COLUMN IF NOT EXISTS followup2_sent boolean DEFAULT false;

-- Timestamp por mensaje (si la tabla de memoria no lo tiene, los recordatorios
-- usan wa_users.last_interaction como aproximación — con la columna son exactos).
ALTER TABLE whatsapp_memoria ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- 2) Rearrancar la campaña de recordatorios SOLO para conversaciones aún
--    "vivas" (ventana de 24h de WhatsApp). Las viejas ya no se pueden
--    contactar por API igualmente.
UPDATE wa_users
SET followup_sent = false, followup2_sent = false
WHERE last_interaction > now() - interval '24 hours'
  AND (funnel_stage IS NULL OR funnel_stage NOT IN ('compradora', 'no_molestar'));

-- 3) (Opcional, manual) Marcar compradoras conocidas para que jamás reciban
--    recordatorios de venta. Ejemplo:
-- UPDATE wa_users SET funnel_stage = 'compradora' WHERE phone = '+57...';
