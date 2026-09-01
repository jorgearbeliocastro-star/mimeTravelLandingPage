// "Latido" de presencia del agente — actualiza profiles.last_active_at
// cada 45s mientras tenga alguna pantalla del panel web abierta y visible,
// para que se pueda saber si está "conectado" (ver
// is_agent_recently_active, 90s de margen). Se pausa solo si la pestaña
// pasa a segundo plano, retoma sola al volver — no manda pings de más.
function startPresenceHeartbeat(supabaseClient) {
  const HEARTBEAT_MS = 45000;
  let timer = null;

  async function ping() {
    const { data } = await supabaseClient.auth.getUser();
    const userId = data?.user?.id;
    if (!userId) return;
    await supabaseClient
      .from('profiles')
      .update({ last_active_at: new Date().toISOString() })
      .eq('id', userId)
      .then(() => {}, () => {}); // no bloqueante — el próximo ping lo corrige
  }

  function start() {
    if (timer) return;
    ping();
    timer = setInterval(ping, HEARTBEAT_MS);
  }
  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  if (document.visibilityState === 'visible') start();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') start();
    else stop();
  });
}

// Si el agente está marcado "no disponible" (ver panel.html) y deja la
// pantalla en segundo plano, la sesión se cierra sola — en el celular al
// toque (se apaga la pantalla, cambia de app, etc.), en la PC con un
// margen de unos minutos por si solo cambió de ventana un momento. Evita
// que quede una sesión de agente abierta sin que nadie la esté mirando
// mientras dure "no disponible".
function startAvailabilityAutoLogout(supabaseClient) {
  const DESKTOP_GRACE_MS = 5 * 60 * 1000; // 5 minutos de margen en PC
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  let logoutTimer = null;

  async function isCurrentlyUnavailable() {
    const { data: userData } = await supabaseClient.auth.getUser();
    const userId = userData?.user?.id;
    if (!userId) return false;
    const { data: profile } = await supabaseClient.from('profiles').select('is_available').eq('id', userId).single();
    return profile?.is_available === false;
  }

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') {
      if (!(await isCurrentlyUnavailable())) return;
      // No hay forma de avisarle a una pestaña ya en segundo plano — al
      // volver a primer plano (o abrir cualquier otra pantalla), el guard
      // de sesión (aal2) de cada página la manda sola a login.html.
      if (isMobile) {
        supabaseClient.auth.signOut();
      } else {
        logoutTimer = setTimeout(() => supabaseClient.auth.signOut(), DESKTOP_GRACE_MS);
      }
    } else if (logoutTimer) {
      clearTimeout(logoutTimer);
      logoutTimer = null;
    }
  });
}
