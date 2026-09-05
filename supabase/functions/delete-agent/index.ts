// Función aparte, propia de la web (mimeTravelLandingPage) — borra la
// cuenta de un agente por completo (Authentication + su fila en
// profiles). Necesita la service_role key porque borrar un usuario de
// Supabase Auth no se puede hacer con el anon key desde el cliente.
// Mismo patrón de autenticación que ya usa create-agent: no hay secreto
// fijo, se manda el token de la sesión del que llama y la función valida
// del lado del servidor que sea el Dueño (role = super_admin) — así nadie
// puede llamarla a mano con solo copiar la URL.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const authHeader = req.headers.get('Authorization') || '';
  const callerToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!callerToken) {
    return new Response(JSON.stringify({ error: 'No autorizado.' }), { status: 401, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Verifica quién llama con SU token (no la service role) y confirma que
  // sea el Dueño — sin esto, cualquiera con la URL podría borrar agentes.
  const { data: callerData, error: callerError } = await admin.auth.getUser(callerToken);
  if (callerError || !callerData?.user) {
    return new Response(JSON.stringify({ error: 'Sesión inválida.' }), { status: 401, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }
  const { data: callerProfile } = await admin.from('profiles').select('role').eq('id', callerData.user.id).maybeSingle();
  if (callerProfile?.role !== 'super_admin') {
    return new Response(JSON.stringify({ error: 'Solo el Dueño puede borrar agentes.' }), { status: 403, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }

  const body = await req.json().catch(() => null);
  const agentId = body?.agentId;
  if (!agentId) {
    return new Response(JSON.stringify({ error: 'Falta agentId.' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }
  // No dejar que el dueño se borre a sí mismo, ni borrar a otro super_admin
  // por error — esta función es solo para dar de baja Agentes normales.
  if (agentId === callerData.user.id) {
    return new Response(JSON.stringify({ error: 'No podés borrarte a vos mismo.' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }
  const { data: targetProfile } = await admin.from('profiles').select('role').eq('id', agentId).maybeSingle();
  if (targetProfile?.role === 'super_admin') {
    return new Response(JSON.stringify({ error: 'No se puede borrar a otro Dueño desde acá.' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }

  const { error: deleteAuthError } = await admin.auth.admin.deleteUser(agentId);
  if (deleteAuthError) {
    return new Response(JSON.stringify({ error: deleteAuthError.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }
  // Por si la fila de profiles no se borra sola en cascada al borrar el
  // usuario de Auth — la sacamos también a mano para no dejar un agente
  // "fantasma" en la lista de Equipo.
  await admin.from('profiles').delete().eq('id', agentId);

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
});
