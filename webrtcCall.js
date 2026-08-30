// Llamada de video/audio punto a punto por WebRTC, señalizada con un canal
// de Supabase Realtime — sin ningún servicio de terceros pago.
//
// v2 (reconstruido desde cero, 2026-08-29): a propósito más simple que la
// versión anterior — sin cola de varias llamadas, sin captura de foto/
// correo en vivo. Esas cosas se suman después, una vez que esto esté
// sólido y probado con una sola llamada por vez.
//
// STUN público de Google + TURN de respaldo (cuenta gratis de Metered,
// app "mimetravelcalls", 20GB/mes) para cuando la conexión directa
// falla. Cuenta nueva creada el 2026-08-30, cupo entero sin usar.
const CALL_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'turn:standard.relay.metered.ca:80', username: '5ee51ca3eef00d733a73a7c3', credential: '2tte+jfOjgEWG+E+' },
  { urls: 'turn:standard.relay.metered.ca:80?transport=tcp', username: '5ee51ca3eef00d733a73a7c3', credential: '2tte+jfOjgEWG+E+' },
  { urls: 'turn:standard.relay.metered.ca:443', username: '5ee51ca3eef00d733a73a7c3', credential: '2tte+jfOjgEWG+E+' },
  { urls: 'turns:standard.relay.metered.ca:443?transport=tcp', username: '5ee51ca3eef00d733a73a7c3', credential: '2tte+jfOjgEWG+E+' },
];

/**
 * Arranca una llamada. `isCaller=true` es quien inicia (el cliente, manda
 * la oferta); `isCaller=false` es quien responde (el agente).
 * `onState(state)` avisa cambios: 'connecting' | 'connected' | 'ended' | 'failed'.
 * Devuelve { hangup, toggleMute, toggleVideo }.
 */
function startWebRTCCall({ supabaseClient, channelName, isCaller, localVideoEl, remoteVideoEl, onState, onDocRequest, onDocPhoto, video = true }) {
  let pc = null;
  let channel = null;
  let localStream = null;
  let remoteDescSet = false;
  let pendingCandidates = [];
  let cleanedUp = false;
  let offerRetryTimer = null;
  let reconnectTimer = null;
  let muted = false;
  let videoOff = false;
  let currentFacingMode = 'user';
  let dataChannel = null;
  const incomingPhotoChunks = {};

  // Canal de datos punto a punto (no pasa por Supabase para nada) para
  // mandar la foto del documento ya recortada/encuadrada del lado del
  // cliente directo a la pantalla del agente. Se manda en pedazos: los
  // canales de datos de WebRTC no garantizan que un mensaje gigante viaje
  // entero de una — con pedazos chicos funciona parejo en cualquier
  // conexión.
  function setupDataChannel(dc) {
    dataChannel = dc;
    dc.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.t !== 'photo-chunk') return;
        const buf = incomingPhotoChunks[msg.id] || (incomingPhotoChunks[msg.id] = { docType: msg.docType, total: msg.total, parts: [] });
        buf.parts[msg.index] = msg.data;
        if (buf.parts.filter(Boolean).length === buf.total) {
          const dataUrl = buf.parts.join('');
          delete incomingPhotoChunks[msg.id];
          if (onDocPhoto) onDocPhoto(buf.docType, dataUrl);
        }
      } catch (e) {
        // no bloqueante
      }
    };
  }

  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    if (offerRetryTimer) clearInterval(offerRetryTimer);
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    if (pc) pc.close();
    if (channel) supabaseClient.removeChannel(channel);
  }

  async function applyPendingCandidates() {
    remoteDescSet = true;
    for (const candidate of pendingCandidates) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        // candidato inválido/tardío — no bloqueante
      }
    }
    pendingCandidates = [];
  }

  (async function start() {
    const logTag = '[call:' + (isCaller ? 'caller' : 'callee') + ']';
    console.log(logTag, 'iniciando, canal:', channelName);
    try {
      // 'user' = cámara frontal, para la conversación normal — se puede
      // pasar a trasera ('environment') en vivo con switchCamera(), sin
      // cortar la llamada, cuando hace falta mostrar un documento.
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: video ? { facingMode: 'user' } : false });
    } catch (e) {
      console.log(logTag, 'getUserMedia falló:', e.name, e.message);
      onState('failed');
      return;
    }
    if (localVideoEl) {
      localVideoEl.srcObject = localStream;
      localVideoEl.muted = true; // nunca escuchar el propio micrófono de vuelta
      localVideoEl.play().catch(() => {});
    }

    pc = new RTCPeerConnection({ iceServers: CALL_ICE_SERVERS });
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    if (isCaller) {
      setupDataChannel(pc.createDataChannel('doc'));
    } else {
      pc.ondatachannel = (event) => setupDataChannel(event.channel);
    }

    pc.ontrack = (event) => {
      if (remoteVideoEl && event.streams[0]) {
        remoteVideoEl.srcObject = event.streams[0];
        remoteVideoEl.play().catch((e) => console.log(logTag, 'error reproduciendo remoto:', e.message));
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(logTag, 'connectionState ->', pc.connectionState);
      if (pc.connectionState === 'connected') {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        onState('connected');
      } else if (pc.connectionState === 'failed') {
        if (reconnectTimer || cleanedUp) return;
        // Reconexión real: el que llamó manda una oferta nueva con
        // iceRestart, que el otro lado contesta con una respuesta nueva
        // (los mismos manejadores de 'offer'/'answer' de más abajo ya
        // saben procesar esto) — no alcanza con solo pedirle al
        // navegador que reinicie ICE sin mandar nada por el canal, eso
        // no reconecta nada de verdad.
        if (isCaller) {
          pc.createOffer({ iceRestart: true }).then((offer) => {
            if (cleanedUp) return;
            return pc.setLocalDescription(offer).then(() => {
              channel.send({ type: 'broadcast', event: 'offer', payload: { sdp: offer } });
            });
          }).catch((e) => console.log(logTag, 'no se pudo reintentar la oferta:', e.message));
        }
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (pc.connectionState !== 'connected') onState('failed');
        }, 12000);
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        channel.send({ type: 'broadcast', event: 'ice-candidate', payload: { candidate: event.candidate, from: isCaller ? 'caller' : 'callee' } });
      }
    };

    // El canal de señalización (Supabase Realtime) es independiente de la
    // conexión de audio/video en sí — una vez conectados, el audio/video
    // sigue fluyendo directo aunque este canal se caiga. PERO si hace
    // falta renegociar más adelante (ej. el reinicio de ICE de arriba) y
    // el canal está muerto, ese intento se pierde en silencio. Por eso
    // esto se puede volver a armar solo si Realtime lo cierra por su
    // cuenta (red, límite del servidor) — no se asume que nunca hace
    // falta después de la conexión inicial.
    let resubscribeTimer = null;
    function setupChannel() {
      if (channel) supabaseClient.removeChannel(channel);
      channel = supabaseClient.channel(channelName, { config: { broadcast: { self: false } } });
      channel
        .on('broadcast', { event: 'offer' }, async ({ payload }) => {
          if (isCaller) return;
          await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
          await applyPendingCandidates();
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          channel.send({ type: 'broadcast', event: 'answer', payload: { sdp: answer } });
        })
        .on('broadcast', { event: 'answer' }, async ({ payload }) => {
          if (!isCaller) return;
          if (offerRetryTimer) {
            clearInterval(offerRetryTimer);
            offerRetryTimer = null;
          }
          await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
          await applyPendingCandidates();
        })
        .on('broadcast', { event: 'ice-candidate' }, async ({ payload }) => {
          if (payload.from === (isCaller ? 'caller' : 'callee')) return;
          if (!remoteDescSet) {
            pendingCandidates.push(payload.candidate);
            return;
          }
          try {
            await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
          } catch (e) {
            // no bloqueante
          }
        })
        .on('broadcast', { event: 'hangup' }, () => {
          console.log(logTag, 'recibido hangup por el canal', channelName);
          onState('ended');
          cleanup();
        })
        .on('broadcast', { event: 'doc-request' }, ({ payload }) => {
          // El agente le pide al cliente que muestre un documento
          // (pasaporte/tarjeta) a la cámara. El cliente se encarga de
          // todo el resto (cambiar de cámara, encuadrar, capturar y
          // volver a la cámara frontal solo) — esto es solo el aviso
          // inicial.
          if (isCaller && onDocRequest) onDocRequest(payload.docType);
        })
        .subscribe(async (status) => {
          console.log(logTag, 'canal Realtime ->', status);
          if (status === 'SUBSCRIBED' && isCaller) {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            // El callee recién se suscribe a este canal cuando el agente
            // atiende — los broadcasts de Realtime no quedan guardados
            // para quien llega tarde, así que se reenvía la oferta hasta
            // recibir 'answer'.
            const sendOffer = () => channel.send({ type: 'broadcast', event: 'offer', payload: { sdp: offer } });
            sendOffer();
            offerRetryTimer = setInterval(sendOffer, 1500);
          }
          if ((status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && !cleanedUp) {
            console.log(logTag, 'canal de señalización se cayó solo (', status, '), reconectando...');
            if (!resubscribeTimer) {
              resubscribeTimer = setTimeout(() => {
                resubscribeTimer = null;
                if (!cleanedUp) setupChannel();
              }, 1000);
            }
          }
        });
    }
    setupChannel();
  })();

  // Cambia de cámara EN VIVO (sin cortar ni reconectar la llamada):
  // pide un track nuevo con la cámara pedida y lo reemplaza en la
  // conexión ya activa (pc.getSenders / replaceTrack), en vez de volver
  // a armar todo desde cero.
  async function switchCamera(facingMode) {
    if (!localStream || !pc || cleanedUp) return;
    const oldTrack = localStream.getVideoTracks()[0];
    if (!oldTrack) return; // llamada de solo audio, no hay cámara que cambiar
    // Importante: la cámara vieja hay que soltarla ANTES de pedir la
    // nueva, no después. Muchos teléfonos (sobre todo gama media/baja)
    // solo dejan tener un stream de cámara abierto a la vez — si se pide
    // el stream nuevo mientras el viejo todavía está activo, falla en
    // silencio (NotReadableError) y la cámara nunca cambia, sin ningún
    // aviso visible.
    localStream.removeTrack(oldTrack);
    oldTrack.stop();
    try {
      // Para documentos (cámara trasera) se pide la resolución más alta
      // posible — sin esto el navegador suele arrancar en algo bajo tipo
      // 640x480, que alcanza para verse en la llamada pero no para leer
      // letra chica de un pasaporte o tarjeta. 'ideal' no falla si el
      // teléfono no llega a esa resolución, simplemente da lo máximo que
      // pueda.
      const videoConstraint = facingMode === 'environment'
        ? { facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } }
        : { facingMode };
      const newStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraint });
      const newTrack = newStream.getVideoTracks()[0];
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(newTrack);
      localStream.addTrack(newTrack);
      if (localVideoEl) {
        localVideoEl.srcObject = localStream;
        localVideoEl.play().catch(() => {});
      }
      currentFacingMode = facingMode;
    } catch (e) {
      console.log('[call] no se pudo cambiar de cámara:', e.message);
      // Si falla, el remitente se queda sin track de video (la cámara
      // vieja ya se soltó) — mejor eso que quedarse mudo del todo, pero
      // hay que poder reintentar: si el que llama vuelve a tocar 🔄 o el
      // agente vuelve a pedir el documento, se prueba de nuevo.
    }
  }

  return {
    async hangup() {
      // Espera a que el aviso de "colgar" realmente salga por el canal
      // ANTES de cerrarlo — si se cierra enseguida, a veces no llega a
      // salir y el otro lado se queda con la llamada "viva" para siempre.
      if (channel) {
        try {
          await channel.send({ type: 'broadcast', event: 'hangup', payload: {} });
        } catch (e) {
          // no bloqueante — igual se cierra todo abajo
        }
      }
      onState('ended');
      cleanup();
    },
    toggleMute() {
      muted = !muted;
      if (localStream) localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
      return muted;
    },
    toggleVideo() {
      videoOff = !videoOff;
      if (localStream) localStream.getVideoTracks().forEach((t) => (t.enabled = !videoOff));
      return videoOff;
    },
    requestDocument(docType) {
      // Solo lo usa el agente (callee), para pedirle al cliente que
      // muestre un documento a la cámara.
      if (channel) channel.send({ type: 'broadcast', event: 'doc-request', payload: { docType } });
    },
    sendDocPhoto(docType, dataUrl) {
      // Solo lo usa el cliente (caller): manda la foto ya recortada por
      // el canal de datos punto a punto (no por Supabase) directo a la
      // pantalla del agente, en pedazos.
      if (!dataChannel || dataChannel.readyState !== 'open') return false;
      const CHUNK_SIZE = 12000;
      const total = Math.ceil(dataUrl.length / CHUNK_SIZE);
      const id = Date.now() + '-' + Math.random().toString(36).slice(2);
      for (let i = 0; i < total; i++) {
        dataChannel.send(JSON.stringify({
          t: 'photo-chunk',
          id,
          docType,
          index: i,
          total,
          data: dataUrl.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
        }));
      }
      return true;
    },
    switchCamera,
    toggleCamera() {
      return switchCamera(currentFacingMode === 'environment' ? 'user' : 'environment');
    },
  };
}
