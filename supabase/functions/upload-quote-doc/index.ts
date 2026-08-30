// Sube la foto de pasaporte/tarjeta que el cliente adjunta al aceptar una
// cotización, a un bucket PRIVADO de Storage ('quote-docs'). Un cliente
// anónimo no tiene sesión real de Supabase Auth, así que no puede escribir
// directo en Storage (ahí es donde vive el RLS de verdad) — esta función
// usa la service role SOLO para esto, después de validar que el
// client_token dado sea realmente el dueño de esa cotización (mismo
// criterio que decide_quote_request/submit_quote_passengers).
//
// El archivo queda en Storage protegido por RLS (solo agent/super_admin
// lo pueden leer) hasta que el agente cierra la venta — recién ahí se
// borra. Así el agente lo puede ver las veces que haga falta, aunque
// cambie de pantalla o entre desde otro dispositivo, sin perderlo.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const WEBHOOK_SECRET = Deno.env.get('UPLOAD_QUOTE_DOC_SECRET')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function respond(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...(init.headers ?? {}) },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if ((req.headers.get('X-Webhook-Secret') ?? '').trim() !== WEBHOOK_SECRET.trim()) {
    return respond({ error: 'No autorizado.' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body) return respond({ error: 'bad request' }, { status: 400 });
  const { token, quoteId, docType, dataUrl } = body as {
    token?: string; quoteId?: string; docType?: string; dataUrl?: string;
  };
  if (!token || !quoteId || !dataUrl || (docType !== 'passport' && docType !== 'card')) {
    return respond({ error: 'Faltan datos.' }, { status: 400 });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Mismo chequeo que hacen las funciones RPC del cliente (client_token
  // tiene que ser dueño de esta cotización) — sin esto, cualquiera con el
  // id de una cotización ajena podría subirle una foto.
  const { data: quote, error: quoteError } = await admin
    .from('quote_requests')
    .select('id')
    .eq('id', quoteId)
    .eq('client_token', token)
    .maybeSingle();
  if (quoteError || !quote) {
    return respond({ error: 'Cotización no encontrada para este dispositivo.' }, { status: 404 });
  }

  const match = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl);
  if (!match) return respond({ error: 'Formato de imagen inválido.' }, { status: 400 });
  const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));

  const path = `${quoteId}/${docType}.jpg`;
  const { error: uploadError } = await admin.storage
    .from('quote-docs')
    .upload(path, bytes, { contentType: 'image/jpeg', upsert: true });
  if (uploadError) {
    return respond({ error: uploadError.message }, { status: 500 });
  }

  const { error: updateError } = await admin
    .from('quote_requests')
    .update({ client_docs_ready: true })
    .eq('id', quoteId);
  if (updateError) {
    return respond({ error: updateError.message }, { status: 500 });
  }

  return respond({ ok: true, path });
});
