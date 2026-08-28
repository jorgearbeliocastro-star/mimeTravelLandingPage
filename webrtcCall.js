// Llamada de video punto a punto por WebRTC, señalizada con un canal de
// Supabase Realtime — mismo mecanismo que ya usa la app nativa
// (useVoiceCall.ts en la expancion), portado a las APIs nativas del
// navegador (no hace falta ninguna librería: RTCPeerConnection,
// getUserMedia, etc. ya vienen en cualquier browser moderno). Sin
// dependencia de Zoom/Twilio ni ningún servicio pago.
//
// STUN público de Google (gratis, sirve para la mayoría de las redes) +
// TURN de respaldo (cuenta gratis de Metered, 500MB/mes) para cuando la
// conexión directa falla — mismos servidores que ya usa la app.
const CALL_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'turn:global.relay.metered.ca:80', username: 'd52c18b58fb01659f875bef8', credential: 'he+xWqvqeYDZphdD' },
  { urls: 'turn:global.relay.metered.ca:80?transport=tcp', username: 'd52c18b58fb01659f875bef8', credential: 'he+xWqvqeYDZphdD' },
  { urls: 'turn:global.relay.metered.ca:443', username: 'd52c18b58fb01659f875bef8', credential: 'he+xWqvqeYDZphdD' },
  { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: 'd52c18b58fb01659f875bef8', credential: 'he+xWqvqeYDZphdD' },
];

// Reduce el tamaño del archivo antes de mandarlo (una foto de cámara de
// celular puede pesar varios MB) — 1600px de lado más largo alcanza de
// sobra para leer un pasaporte, y hace que el envío por el canal de datos
// sea rápido. Nunca toca un servidor — todo pasa en el propio navegador.
function downscaleImageToBlob(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          URL.revokeObjectURL(url);
          if (blob) resolve(blob);
          else reject(new Error('No se pudo procesar la imagen'));
        },
        'image/jpeg',
        quality
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('No se pudo leer la imagen'));
    };
    img.src = url;
  });
}

/**
 * Arranca una llamada de video. `isCaller=true` es quien inicia (manda la
 * oferta, el cliente); `isCaller=false` es quien responde (el agente).
 * `onState(state)` avisa cambios: 'connecting' | 'connected' | 'ended' | 'failed'.
 * `onPhoto(blob)` (opcional) — se dispara cuando llega una foto por el
 * canal de datos (ver sendPhoto más abajo); nunca toca Supabase ni ningún
 * servidor, viaja directo entre los dos navegadores y solo existe en
 * memoria mientras dura la llamada.
 * Devuelve { hangup, toggleMute, toggleVideo, sendPhoto } — el estado de
 * mute/video se consulta con los getters que trae el objeto devuelto.
 */
function startWebRTCCall({ supabaseClient, channelName, isCaller, localVideoEl, remoteVideoEl, onState, onPhoto, onPhotoRequest, onEmailRequest, onEmail, video = true }) {
  let pc = null;
  let channel = null;
  let localStream = null;
  let remoteDescSet = false;
  let pendingCandidates = [];
  let cleanedUp = false;
  let offerRetryTimer = null;
  let muted = false;
  let videoOff = false;
  let dataChannel = null;
  let photoReceiveChunks = null;
  let photoReceiveMime = null;
  let photoReceiveKind = null;
  let cameraTrack = null; // se guarda aparte para poder volver a ella al dejar de compartir pantalla
  let screenStream = null;
  let sharingScreen = false;

  // Se arma igual del lado que llama y del lado que atiende — quien crea
  // el canal es el llamante (pc.createDataChannel), el otro lado lo recibe
  // por pc.ondatachannel; a partir de ahí los dos pueden mandar fotos.
  function setupDataChannel(dc) {
    dataChannel = dc;
    dataChannel.binaryType = 'arraybuffer';
    dataChannel.bufferedAmountLowThreshold = 65536;
    dataChannel.onmessage = (event) => {
      if (typeof event.data === 'string') {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (e) {
          return;
        }
        if (msg.type === 'photo-start') {
          photoReceiveChunks = [];
          photoReceiveMime = msg.mimeType || 'image/jpeg';
          photoReceiveKind = msg.kind || 'document';
        } else if (msg.type === 'photo-end' && photoReceiveChunks) {
          const blob = new Blob(photoReceiveChunks, { type: photoReceiveMime });
          const kind = photoReceiveKind;
          photoReceiveChunks = null;
          photoReceiveKind = null;
          if (onPhoto) onPhoto(blob, kind);
        } else if (msg.type === 'email-data') {
          // Nunca pasa por Supabase en este punto — viaja directo entre los
          // dos navegadores, igual que la foto. Es el agente quien decide
          // después si lo guarda (ver onEmail en agente/llamadas.html).
          if (onEmail) onEmail(msg.email, msg.source || 'manual');
        }
      } else if (photoReceiveChunks) {
        photoReceiveChunks.push(event.data);
      }
    };
  }

  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    if (offerRetryTimer) clearInterval(offerRetryTimer);
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
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
    console.log('[call:' + (isCaller ? 'caller' : 'callee') + ']', 'iniciando, canal:', channelName);
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video });
    } catch (e) {
      console.log('[call]', 'getUserMedia falló:', e.name, e.message);
      onState('failed');
      return;
    }
    cameraTrack = localStream.getVideoTracks()[0] || null;
    if (localVideoEl) {
      localVideoEl.srcObject = localStream;
      localVideoEl.muted = true; // nunca escuchar el propio micrófono de vuelta
      localVideoEl.play().catch(() => {});
    }

    pc = new RTCPeerConnection({ iceServers: CALL_ICE_SERVERS });
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    // El que llama crea el canal de datos (para la foto del pasaporte);
    // el otro lado lo recibe acá cuando se negocie la conexión.
    if (isCaller) {
      setupDataChannel(pc.createDataChannel('photo'));
    } else {
      pc.ondatachannel = (event) => setupDataChannel(event.channel);
    }

    const logTag = '[call:' + (isCaller ? 'caller' : 'callee') + ']';

    pc.ontrack = (event) => {
      console.log(logTag, 'ontrack recibido, streams:', event.streams.length);
      if (remoteVideoEl && event.streams[0]) {
        remoteVideoEl.srcObject = event.streams[0];
        remoteVideoEl.play().catch((e) => console.log(logTag, 'error reproduciendo remoto:', e.message));
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(logTag, 'connectionState ->', pc.connectionState, '| iceConnectionState:', pc.iceConnectionState);
      if (pc.connectionState === 'connected') onState('connected');
      else if (pc.connectionState === 'failed') onState('failed');
    };

    // Diagnóstico: si ninguno de los candidatos generados es "relay" (TURN)
    // ni logra conectar, es señal de que el TURN de respaldo tampoco está
    // sirviendo para esta conexión puntual.
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const type = (event.candidate.candidate || '').split(' ')[7];
        console.log(logTag, 'candidato local:', type);
        channel.send({ type: 'broadcast', event: 'ice-candidate', payload: { candidate: event.candidate, from: isCaller ? 'caller' : 'callee' } });
      } else {
        console.log(logTag, 'fin de recolección de candidatos');
      }
    };

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
        onState('ended');
        cleanup();
      })
      // El agente pide una foto puntual (pasaporte/tarjeta) — va por el
      // canal de señalización (ya está levantado desde el arranque, a
      // diferencia del canal de datos que recién existe una vez que la
      // conexión de video terminó de armarse), así el aviso le llega al
      // cliente apenas el agente lo pide, sin esperar nada más.
      .on('broadcast', { event: 'request-photo' }, ({ payload }) => {
        if (onPhotoRequest) onPhotoRequest(payload.kind);
      })
      // Mismo mecanismo que "pedir foto" pero para el correo — el agente
      // lo pide solo cuando de verdad hace falta (para emitir el tiket),
      // el cliente decide cómo responder (a mano o con Google) del otro
      // lado (ver onEmailRequest).
      .on('broadcast', { event: 'request-email' }, () => {
        if (onEmailRequest) onEmailRequest();
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED' && isCaller) {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          // El callee recién se suscribe a este canal cuando el agente
          // atiende — los broadcasts de Realtime no quedan guardados para
          // quien llega tarde, así que se reenvía la oferta hasta recibir
          // 'answer' (mismo motivo que en la app nativa).
          const sendOffer = () => channel.send({ type: 'broadcast', event: 'offer', payload: { sdp: offer } });
          sendOffer();
          offerRetryTimer = setInterval(sendOffer, 1500);
        }
      });
  })();

  async function stopScreenShareInternal(localVideoEl) {
    if (!sharingScreen) return;
    if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
    sharingScreen = false;
    const sender = pc && pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender && cameraTrack) await sender.replaceTrack(cameraTrack);
    if (localVideoEl && localStream) localVideoEl.srcObject = localStream;
  }

  return {
    async hangup() {
      // Espera a que el aviso de "colgar" realmente salga por el canal
      // ANTES de cerrarlo — si se cierra el canal enseguida, el mensaje a
      // veces no llega a salir y el otro lado se queda con la llamada
      // "viva" para siempre.
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
    // Lo usa el agente para pedirle al cliente que muestre el pasaporte o
    // la tarjeta — el cliente recibe el aviso por onPhotoRequest y ahí
    // decide si toma la foto (no se le abre la cámara sola, el navegador
    // no deja hacer eso sin que la persona toque algo).
    requestPhoto(kind) {
      if (channel) channel.send({ type: 'broadcast', event: 'request-photo', payload: { kind } });
    },
    // Lo usa el agente para pedirle el correo al cliente — mismo patrón que
    // requestPhoto: el aviso le llega ya (canal de señalización, no el de
    // datos), el cliente decide si lo escribe a mano o entra con Google.
    requestEmail() {
      if (channel) channel.send({ type: 'broadcast', event: 'request-email', payload: {} });
    },
    toggleMute() {
      if (!localStream) return muted;
      muted = !muted;
      localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
      return muted;
    },
    toggleVideo() {
      if (!localStream) return videoOff;
      videoOff = !videoOff;
      localStream.getVideoTracks().forEach((t) => (t.enabled = !videoOff));
      return videoOff;
    },
    // Comparte la pantalla del agente en vez de la cámara — reemplaza la
    // track de video que ya viaja por la conexión (sin tener que
    // renegociar nada), así el otro lado la ve en el mismo cuadro de
    // video de siempre. Vuelve sola a la cámara si el agente usa el botón
    // nativo del navegador ("Dejar de compartir") en vez del nuestro.
    async startScreenShare(localVideoEl) {
      if (!pc) throw new Error('La llamada todavía no está lista.');
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(screenTrack);
      if (localVideoEl) localVideoEl.srcObject = screenStream;
      sharingScreen = true;
      screenTrack.onended = () => stopScreenShareInternal(localVideoEl);
      return true;
    },
    stopScreenShare(localVideoEl) {
      return stopScreenShareInternal(localVideoEl);
    },
    isSharingScreen() {
      return sharingScreen;
    },
    // Manda una foto (pasaporte, tarjeta de pago, lo que haga falta)
    // directo al otro lado de la llamada, en pedazos chicos por el canal
    // de datos — nunca toca Supabase ni ningún servidor nuestro, y no
    // queda guardada en ningún lado una vez que el otro la recibe (solo
    // vive en la memoria del navegador de quien la ve, mientras dura la
    // llamada). `kind` es solo una etiqueta para que el que la reciba
    // sepa qué está mirando (ej. 'passport', 'card').
    async sendPhoto(file, kind) {
      if (!dataChannel || dataChannel.readyState !== 'open') {
        throw new Error('El canal para mandar la foto todavía no está listo.');
      }
      const blob = await downscaleImageToBlob(file, 1600, 0.8);
      const buffer = await blob.arrayBuffer();
      dataChannel.send(JSON.stringify({ type: 'photo-start', mimeType: blob.type, size: buffer.byteLength, kind: kind || 'document' }));
      const CHUNK_SIZE = 16384;
      for (let offset = 0; offset < buffer.byteLength; offset += CHUNK_SIZE) {
        if (dataChannel.bufferedAmount > 262144) {
          await new Promise((resolve) => {
            dataChannel.onbufferedamountlow = () => {
              dataChannel.onbufferedamountlow = null;
              resolve();
            };
          });
        }
        dataChannel.send(buffer.slice(offset, offset + CHUNK_SIZE));
      }
      dataChannel.send(JSON.stringify({ type: 'photo-end' }));
    },
    // Manda el correo directo por el canal de datos — igual que la foto,
    // nunca toca Supabase de este lado; es el agente quien decide después
    // si lo guarda (ver onEmail). `source` es 'manual' o 'google', solo
    // para que el agente sepa qué tan confiable es el dato.
    sendEmail(email, source) {
      if (!dataChannel || dataChannel.readyState !== 'open') {
        throw new Error('El canal para mandar el correo todavía no está listo.');
      }
      dataChannel.send(JSON.stringify({ type: 'email-data', email, source: source || 'manual' }));
    },
  };
}
