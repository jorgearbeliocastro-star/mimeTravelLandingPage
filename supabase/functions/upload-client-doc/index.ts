// Función aparte, propia de la web (mimeTravelLandingPage) — cierra el
// hueco de seguridad de la subida de documentos del cliente (pasaporte/
// tarjeta): antes el navegador subía directo al bucket privado
// `client-documents` (política `client_documents_insert_anon`) sin que
// nadie comprobara que el `quoteId` recibido era realmente el dueño de
// esa cotización — alguien con el UUID de la cotización de otro cliente
// podía subir un archivo y pisar/reemplazar su documento real (no podía
// LEERLO, esa política ya estaba bien cerrada al agente asignado, pero sí
// arruinarlo). Ahora toda subida pasa por acá, que valida `client_token`
// contra la fila real de `quote_requests` con la service role key ANTES
// de aceptar el archivo — la política de INSERT directo del navegador
// debe quedar retirada una vez esto esté deployado (ver SQL aparte).
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const WEBHOOK_SECRET = Deno.env.get('WEB_PUSH_WEBHOOK_SECRET')!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Mismo criterio que send-web-push/record-payment-consent: la llama el
// navegador directo desde index.html, así que hacen falta estos headers
// para que el preflight OPTIONS no la bloquee antes de que llegue el
// X-Webhook-Secret siquiera. Reusa el mismo secreto que send-web-push —
// es un chequeo anti-abuso liviano, no una autenticación real (esa la
// hace el chequeo de client_token de abajo, que es el que de verdad
// importa acá).
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

  const { quoteId, clientToken, docType, dataBase64 } = body;
  if (!quoteId || !clientToken || !docType || !dataBase64) {
    return new Response('missing fields', { status: 400, headers: CORS_HEADERS });
  }
  if (docType !== 'passport' && docType !== 'card') {
    return new Response('invalid docType', { status: 400, headers: CORS_HEADERS });
  }

  // El chequeo que de verdad cierra el hueco: que ese client_token sea el
  // dueño real de esta cotización puntual. Sin esto, cualquiera que
  // consiguiera/adivinara el UUID de OTRA cotización podía pisar su
  // documento sin ser su cliente.
  const { data: quote, error: quoteErr } = await supabase
    .from('quote_requests')
    .select('id, client_token')
    .eq('id', quoteId)
    .maybeSingle();
  if (quoteErr) return new Response(JSON.stringify({ error: quoteErr.message }), { status: 500, headers: CORS_HEADERS });
  if (!quote || quote.client_token !== clientToken) {
    return new Response('forbidden', { status: 403, headers: CORS_HEADERS });
  }

  let bytes;
  try {
    bytes = Uint8Array.from(atob(dataBase64), (c) => c.charCodeAt(0));
  } catch {
    return new Response('invalid dataBase64', { status: 400, headers: CORS_HEADERS });
  }

  const path = quoteId + '/' + docType + '.jpg';
  const { error: uploadErr } = await supabase.storage
    .from('client-documents')
    .upload(path, bytes, { upsert: true, contentType: 'image/jpeg' });
  if (uploadErr) return new Response(JSON.stringify({ error: uploadErr.message }), { status: 500, headers: CORS_HEADERS });

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
});
