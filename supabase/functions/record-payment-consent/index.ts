// Función aparte de la web (mimeTravelLandingPage) — deja constancia de que
// el cliente autorizó el cobro de una cotización (checkbox obligatorio
// antes de aceptar), guardando fecha/hora Y la IP real desde donde lo
// marcó. La IP no la puede leer el navegador de sí mismo — hace falta que
// el servidor la tome de la conexión HTTP real, por eso esto es una
// función y no un RPC directo a la base.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const WEBHOOK_SECRET = Deno.env.get('PAYMENT_CONSENT_WEBHOOK_SECRET')!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

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
  if (!body || !body.token || !body.quoteId) {
    return new Response('bad request', { status: 400, headers: CORS_HEADERS });
  }

  // Mismo header que ya usa Supabase/Deno Deploy detrás de su proxy — es
  // la IP real del navegador que hizo la llamada, no la de Supabase.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'desconocida';

  // Verificado por token (igual que record_payment_consent hacía por SQL)
  // — solo puede marcar consentimiento en SU PROPIA cotización, no en
  // cualquier id que mande.
  const { data, error } = await supabase
    .from('quote_requests')
    .update({ payment_consent_at: new Date().toISOString(), payment_consent_ip: ip })
    .eq('id', body.quoteId)
    .eq('client_token', body.token)
    .select('id');

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: CORS_HEADERS });
  if (!data || data.length === 0) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: CORS_HEADERS });
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
});
