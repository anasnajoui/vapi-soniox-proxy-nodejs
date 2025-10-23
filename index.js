import WebSocket, { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
dotenv.config();

const PORT = process.env.PORT || 3000;
const FINALIZE_TIMEOUT_MS = 5000; // Timeout in caso di silenzio

// Funzione per estrarre il canale SINISTRO (utente) dall'audio stereo
function stereoToMonoLeft(buf) {
  const out = Buffer.alloc(buf.length / 2);
  for (let i = 0, j = 0; i < buf.length; i += 4, j += 2) {
    out[j] = buf[i];
    out[j+1] = buf[i+1];
  }
  return out;
}
// Funzione per estrarre il canale DESTRO (assistente) dall'audio stereo
function stereoToMonoRight(buf) {
  const out = Buffer.alloc(buf.length / 2);
  for (let i = 0, j = 0; i < buf.length; i += 4, j += 2) {
    out[j] = buf[i+2];
    out[j+1] = buf[i+3];
  }
  return out;
}

// Funzione per creare una singola connessione a Soniox
function createSonioxSocket(vapiSocket, sampleRateRef, who) {
  const sonioxSocket = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket', { perMessageDeflate: false });
  sonioxSocket._socket?.setNoDelay?.(true);

  let segment = [];
  let finalizeTimer;

  const resetFinalizeTimer = () => {
    clearTimeout(finalizeTimer);
    finalizeTimer = setTimeout(() => {
      if (sonioxSocket.readyState === WebSocket.OPEN) {
        console.log(`[${who}] Forza la finalizzazione dopo ${FINALIZE_TIMEOUT_MS}ms di silenzio`);
        sonioxSocket.send(JSON.stringify({ type: 'finalize' }));
      }
    }, FINALIZE_TIMEOUT_MS);
  };

  sonioxSocket.on('open', () => {
    console.log(`Connesso a Soniox per ${who}`);
    sonioxSocket.send(JSON.stringify({
      api_key: process.env.SONIOX_API_KEY,
      model: "it_IT", // MODIFICATO PER ITALIANO
      audio_format: "pcm_s16le",
      sample_rate: sampleRateRef.value,
      num_channels: 1, // Inviamo audio mono
      enable_endpoint_detection: true,
      enable_language_identification: false
    }));
    resetFinalizeTimer();
  });

  sonioxSocket.on('message', (sMsg) => {
    try {
      const resp = JSON.parse(sMsg.toString());
      if (resp.error_code) {
        console.error(`Errore Soniox (${who}):`, resp.error_code, resp.error_message);
        return;
      }

      const tokens = Array.isArray(resp.tokens) ? resp.tokens : [];
      for (const t of tokens) {
        if (!t || !t.is_final || typeof t.text !== 'string') continue;

        if (t.text === '<end>') {
          const text = segment.join('').replace(/\s+/g, ' ').trim();
          segment = [];
          if (text && who === 'customer') { // INVIAMO SOLO LA TRASCRIZIONE DEL CLIENTE
            console.log(`→ ${who}: ${text}`);
            vapiSocket.send(JSON.stringify({
              type: 'transcriber-response',
              transcription: text,
              channel: who
            }));
          }
        } else {
          segment.push(t.text);
        }
      }
    } catch (e) {
      console.error(`Errore nel parsing del messaggio Soniox (${who}):`, e);
    }
  });

  sonioxSocket.on('close', () => clearTimeout(finalizeTimer));
  sonioxSocket.on('error', (err) => console.error(`Errore Soniox ${who}:`, err));

  return { socket: sonioxSocket, resetFinalizeTimer };
}

const wss = new WebSocketServer({ port: PORT, perMessageDeflate: false }, () => {
  console.log(`Server proxy in ascolto su ws://localhost:${PORT}`);
});

// Gestisce la connessione principale da Vapi
wss.on('connection', (vapiSocket) => {
  vapiSocket._socket?.setNoDelay?.(true);
  console.log('Vapi connesso');

  const sampleRateRef = { value: 16000 };
  let left, right;

  vapiSocket.on('message', (msg, isBinary) => {
    if (!isBinary) {
      const data = JSON.parse(msg.toString());
      if (data.type === 'start') {
        sampleRateRef.value = data.sampleRate || 16000;
        console.log('Ricevuto messaggio di start, Sample Rate=', sampleRateRef.value);
        // Crea una connessione Soniox per il canale sinistro (utente)
        left = createSonioxSocket(vapiSocket, sampleRateRef, "customer");
        // Crea una connessione Soniox per il canale destro (assistente)
        right = createSonioxSocket(vapiSocket, sampleRateRef, "assistant");
      }
    } else {
      // Inoltra l'audio separato ai rispettivi socket Soniox
      if (left?.socket?.readyState === WebSocket.OPEN) {
        const mono = stereoToMonoLeft(msg);
        left.socket.send(mono);
        left.resetFinalizeTimer();
      }
      if (right?.socket?.readyState === WebSocket.OPEN) {
        const mono = stereoToMonoRight(msg);
        right.socket.send(mono);
        right.resetFinalizeTimer();
      }
    }
  });

  vapiSocket.on('close', () => {
    console.log('Vapi disconnesso');
    left?.socket?.close();
    right?.socket?.close();
  });
});