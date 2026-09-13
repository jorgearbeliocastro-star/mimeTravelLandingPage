// Función aparte, propia de la web (mimeTravelLandingPage) — avisa al
// CLIENTE por correo, en paralelo a la notificación push (send-web-push).
// Se agregó porque el push depende de que el cliente lo haya aceptado, y
// el teléfono como respaldo tiene problemas reales con clientes de otros
// países (llamar al exterior tiene costo y no siempre es posible) — el
// correo, en cambio, es obligatorio para todo cliente sin excepción y no
// tiene ningún problema de país.
//
// Manda por SMTP con una cuenta de Gmail real (GMAIL_USER +
// GMAIL_APP_PASSWORD, una "contraseña de aplicación" — no la contraseña
// normal de la cuenta). Esta cuenta es TEMPORAL, solo mientras dura la
// prueba de la web — más adelante cada agente va a tener su propio correo
// configurado para mandarle a sus clientes, esto no lo reemplaza, es
// nada más el arranque.
import { createClient } from 'npm:@supabase/supabase-js@2';
import nodemailer from 'npm:nodemailer@6.9.14';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const WEBHOOK_SECRET = Deno.env.get('WEB_PUSH_WEBHOOK_SECRET')!;
// Nombres propios (no GMAIL_USER/GMAIL_APP_PASSWORD a secas) — este mismo
// proyecto de Supabase ya tenía esos nombres ocupados por otra cosa (ver
// CLAUDE.md, "la expancion" comparte este proyecto), así que se usan
// nombres específicos para no pisar ese secreto existente.
const GMAIL_USER = Deno.env.get('CLIENT_EMAIL_GMAIL_USER')!;
const GMAIL_APP_PASSWORD = Deno.env.get('CLIENT_EMAIL_GMAIL_APP_PASSWORD')!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
});

// Mismo criterio que las otras funciones propias de esta web: la llama el
// navegador del agente directo desde panel.html, hacen falta estos
// headers para que el preflight OPTIONS no la bloquee antes de que llegue
// el X-Webhook-Secret. Reusa el mismo secreto que send-web-push — no es
// autenticación real, es un chequeo anti-abuso liviano.
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

  const { quoteId, subject, text } = body;
  if (!quoteId || !subject || !text) {
    return new Response('missing fields', { status: 400, headers: CORS_HEADERS });
  }

  // El correo del cliente no lo manda el navegador — se busca en la base
  // por el id de la cotización, así no hay forma de que alguien mande
  // este aviso a una dirección arbitraria con solo cambiar el pedido.
  const { data: quote, error: quoteErr } = await supabase
    .from('quote_requests')
    .select('contact_email')
    .eq('id', quoteId)
    .maybeSingle();
  if (quoteErr) return new Response(JSON.stringify({ error: quoteErr.message }), { status: 500, headers: CORS_HEADERS });
  if (!quote || !quote.contact_email) {
    return new Response('no contact email for this quote', { status: 404, headers: CORS_HEADERS });
  }

  try {
    await transporter.sendMail({
      from: '"Mime Travel" <' + GMAIL_USER + '>',
      to: quote.contact_email,
      subject,
      text,
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: CORS_HEADERS });
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
});
