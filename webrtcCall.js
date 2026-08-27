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

/**
 * Arranca una llamada de video. `isCaller=true` es quien inicia (manda la
 * oferta, el cliente); `isCaller=false` es quien responde (el agente).
 * `onState(state)` avisa cambios: 'connecting' | 'connected' | 'ended' | 'failed'.
 * Devuelve { hangup, toggleMute, toggleVideo } — el estado de mute/video se
 * consulta con los getters que trae el objeto devuelto.
 */
function startWebRTCCall({ supabaseClient, channelName, isCaller, localVideoEl, remoteVideoEl, onState }) {
  let pc = null;
  let channel = null;
  let localStream = null;
  let remoteDescSet = false;
  let pendingCandidates = [];
  let cleanedUp = false;
  let offerRetryTimer = null;
  let muted = false;
  let videoOff = false;

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
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    } catch (e) {
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
  };
}
