// Función aparte, propia de la web (mimeTravelLandingPage) — le cambia el
// correo y/o la contraseña a un agente. Necesita la service_role key
// porque eso no se puede hacer con el anon key desde el cliente. Mismo
// patrón de autenticación que create-agent/delete-agent: no hay secreto
// fijo, se manda el token de la sesión del que llama y la función valida
// del lado del servidor que sea el Dueño (role = super_admin).
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

  const { data: callerData, error: callerError } = await admin.auth.getUser(callerToken);
  if (callerError || !callerData?.user) {
    return new Response(JSON.stringify({ error: 'Sesión inválida.' }), { status: 401, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }
  const { data: callerProfile } = await admin.from('profiles').select('role').eq('id', callerData.user.id).maybeSingle();
  if (callerProfile?.role !== 'super_admin') {
    return new Response(JSON.stringify({ error: 'Solo el Dueño puede editar agentes.' }), { status: 403, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }

  const body = await req.json().catch(() => null);
  const agentId = body?.agentId;
  const newEmail = body?.newEmail ? String(body.newEmail).trim() : null;
  const newPassword = body?.newPassword ? String(body.newPassword) : null;
  if (!agentId || (!newEmail && !newPassword)) {
    return new Response(JSON.stringify({ error: 'Falta agentId y al menos un cambio (correo o contraseña).' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }
  if (newPassword && newPassword.length < 6) {
    return new Response(JSON.stringify({ error: 'La contraseña necesita al menos 6 caracteres.' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }
  // Mismo criterio de seguridad que delete-agent: esto es para editar
  // Agentes normales, no para tocar la propia cuenta del dueño ni la de
  // otro super_admin desde este atajo.
  if (agentId === callerData.user.id) {
    return new Response(JSON.stringify({ error: 'No podés editarte a vos mismo desde acá.' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }
  const { data: targetProfile } = await admin.from('profiles').select('role').eq('id', agentId).maybeSingle();
  if (targetProfile?.role === 'super_admin') {
    return new Response(JSON.stringify({ error: 'No se puede editar a otro Dueño desde acá.' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }

  const updates: { email?: string; password?: string } = {};
  if (newEmail) updates.email = newEmail;
  if (newPassword) updates.password = newPassword;

  const { error: updateError } = await admin.auth.admin.updateUserById(agentId, updates);
  if (updateError) {
    return new Response(JSON.stringify({ error: updateError.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
});
