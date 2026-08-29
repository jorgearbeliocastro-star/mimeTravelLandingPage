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
  // Sin agentId = avisa a TODOS los agentes suscriptos (llamada general,
  // sin agente asignado — mismo criterio que el pool de siempre).
  let query = supabase.from('agent_push_subscriptions').select('subscription, agent_id');
  if (body.agentId) query = query.eq('agent_id', body.agentId);
  const { data: subs, error } = await query;
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: CORS_HEADERS });

  // No le avisa (ni le suena ni le vibra el celular) a un agente que ya
  // está en otra llamada — mismo criterio que get_ringing_calls_for_agent
  // ya aplica tanto para el pool como para las dirigidas puntualmente
  // (ver migraciones 0085/0091 de la-expancion). Antes esto se le
  // mandaba igual, así que aunque ya no le sonara ni le apareciera en la
  // lista, el aviso del sistema (con su propio sonido) le seguía
  // llegando de todos modos.
  const agentIds = [...new Set((subs ?? []).map((s: any) => s.agent_id).filter(Boolean))];
  const busyChecks = await Promise.all(
    agentIds.map((id) => supabase.rpc('is_agent_busy', { p_agent_id: id }))
  );
  const busyAgentIds = new Set(agentIds.filter((_, i) => busyChecks[i].data === true));
  const targetSubs = (subs ?? []).filter((s: any) => !s.agent_id || !busyAgentIds.has(s.agent_id));

  const payload = JSON.stringify({ title, body: msgBody, url });
  const results = await Promise.allSettled(
    targetSubs.map((row: any) => webpush.sendNotification(row.subscription, payload))
  );
  // Las suscripciones que ya no sirven (410/404 — el navegador se
  // desinstaló, se borraron los datos, etc.) se limpian solas para no
  // acumular basura ni seguir intentando mandarles para siempre.
  const expired: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected' && (r.reason?.statusCode === 410 || r.reason?.statusCode === 404)) {
      expired.push((targetSubs[i] as any).subscription.endpoint);
    }
  });
  if (expired.length) {
    await supabase.from('agent_push_subscriptions').delete().in('subscription->>endpoint', expired);
  }

  return new Response(JSON.stringify({ sent: results.filter((r) => r.status === 'fulfilled').length }), {
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
});
