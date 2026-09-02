// Service worker del panel de agente — solo se encarga de mostrar las
// notificaciones push reales del navegador (cotizaciones nuevas) y de
// llevar al agente a la pantalla correspondiente al tocarlas. No cachea
// nada de la página (no hace falta que el panel funcione sin conexión).
//
// skipWaiting + clients.claim: sin esto, una versión nueva de este archivo
// se queda "esperando" hasta que se cierren TODAS las pestañas del panel
// — puede tardar días en activarse sola. Así se activa apenas se detecta.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

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
    icon: '../icon-192.png',
    badge: '../icon-192.png',
    data: { url: data.url || '/agente/panel.html' },
    requireInteraction: true,
  };
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      // Si el panel ya está abierto en alguna pestaña, le avisa directo
      // (sin esto, el número de la pestaña recién se actualizaba en el
      // próximo sondeo automático, hasta unos segundos después).
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
        clientsArr.forEach((client) => client.postMessage({ type: 'push-received' }));
      }),
    ])
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data && event.notification.data.url ? event.notification.data.url : '/agente/panel.html';
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
