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
