// Función aparte, propia de la web (mimeTravelLandingPage) — NO toca ni
// depende de la función "send-request-notification" que usa la app nativa
// (la expancion). Manda una notificación push real del navegador a los
// agentes que se suscribieron desde el panel web (agente/panel.html),
// usando el protocolo estándar Web Push (VAPID) — sin ningún servicio
// pago de terceros.
//
// Deployada directo a este mismo proyecto de Supabase (mismo que usa la
// app), pero el código fuente vive acá, en el repo de la web, separado a
// propósito.
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC_KEY = Deno.env.get('WEB_PUSH_VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('WEB_PUSH_VAPID_PRIVATE_KEY')!;
const WEBHOOK_SECRET = Deno.env.get('WEB_PUSH_WEBHOOK_SECRET')!;

webpush.setVapidDetails('mailto:contacto@mimetravel.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// La llama el navegador directo desde llamar.html — sin estos headers, el
// preflight OPTIONS del navegador bloquea la llamada antes de que llegue
// el X-Webhook-Secret siquiera (mismo criterio que send-request-notification).
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.headers.get('X-Webhook-Secret') !== WEBHOOK_SECRET) {
    return new Response('unauthorized', { status: 401, headers: CORS_HEADERS });
  }
  const body = await req.json().catch(() => null);
  if (!body) return new Response('bad request', { status: 400, headers: CORS_HEADERS });

  const { title, body: msgBody, url } = body;
  // Sin agentId = avisa a TODOS los agentes suscriptos (cotización general,
  // sin agente asignado).
  let query = supabase.from('agent_push_subscriptions').select('subscription');
  if (body.agentId) query = query.eq('agent_id', body.agentId);
  let { data: subs, error } = await query;
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: CORS_HEADERS });

  // Respaldo: si había un agente puntual pero justo no tiene NINGUNA
  // suscripción activa (teléfono reseteado, caché borrada, etc.), el
  // aviso no se pierde en silencio — cae al pool general, igual que una
  // cotización sin agente asignado. Sin esto, un cliente que ya tenía
  // agente podía escribir y que nadie del equipo se enterara nunca.
  let usedFallback = false;
  if (body.agentId && (!subs || subs.length === 0)) {
    const fallback = await supabase.from('agent_push_subscriptions').select('subscription');
    if (fallback.error) return new Response(JSON.stringify({ error: fallback.error.message }), { status: 500, headers: CORS_HEADERS });
    subs = fallback.data;
    usedFallback = true;
  }

  const payload = JSON.stringify({ title, body: msgBody, url });
  const results = await Promise.allSettled(
    (subs ?? []).map((row: any) => webpush.sendNotification(row.subscription, payload))
  );
  // Las suscripciones que ya no sirven (410/404 — el navegador se
  // desinstaló, se borraron los datos, etc.) se limpian solas para no
  // acumular basura ni seguir intentando mandarles para siempre.
  const expired: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected' && (r.reason?.statusCode === 410 || r.reason?.statusCode === 404)) {
      expired.push((subs![i] as any).subscription.endpoint);
    }
  });
  if (expired.length) {
    await supabase.from('agent_push_subscriptions').delete().in('subscription->>endpoint', expired);
  }

  return new Response(JSON.stringify({ sent: results.filter((r) => r.status === 'fulfilled').length, usedFallback }), {
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
});
