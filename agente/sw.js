// Service worker del panel de agente — solo se encarga de mostrar las
// notificaciones push reales del navegador (llamadas entrantes) y de
// llevar al agente a la pantalla correspondiente al tocarlas. No cachea
// nada de la página (no hace falta que el panel funcione sin conexión).

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Mime Travel', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Mime Travel';
  const options = {
    body: data.body || '',
    icon: '../logo-v4.png',
    badge: '../logo-v4.png',
    data: { url: data.url || 'llamadas.html' },
    requireInteraction: true, // una llamada entrante no debe desaparecer sola en unos segundos
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data && event.notification.data.url ? event.notification.data.url : 'llamadas.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      // Si ya hay una pestaña del panel abierta, la enfoca y navega ahí en
      // vez de abrir una pestaña nueva cada vez.
      for (const client of clientsArr) {
        if (client.url.includes('/agente/') && 'focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
