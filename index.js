import WebSocket, { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
dotenv.config();

const PORT = process.env.PORT || 3000;

// Funzione per estrarre SOLO il canale SINISTRO (utente)
function stereoToMonoLeft(buf) {
  const out = Buffer.alloc(buf.length / 2);
  for (let i = 0, j = 0; i < buf.length; i += 4, j += 2) {
    out[j] = buf[i];
    out[j+1] = buf[i+1];
  }
  return out;
}

// Funzione per creare una connessione a Soniox, implementando la logica di Edel
function createSonioxSocket(vapiSocket, sampleRate) {
  const sonioxSocket = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket', { perMessageDeflate: false });

  let segment = []; // Buffer per accumulare le parole di una frase

  sonioxSocket.on('open', () => {
    console.log(`Connesso a Soniox per il cliente`);
    sonioxSocket.send(JSON.stringify({
      api_key: process.env.SONIOX_API_KEY,
      model: "stt-rt-v3",
      language_hints: ["it"],
      audio_format: "pcm_s16le",
      sample_rate: sampleRate,
      num_channels: 1, // Inviamo audio mono
      enable_endpoint_detection: true,
      include_nonfinal: false, // Come Edel, usiamo solo i risultati finali
    }));
  });

  sonioxSocket.on('message', (sMsg) => {
    try {
      const resp = JSON.parse(sMsg.toString());
      if (resp.error_code) {
        console.error(`Errore Soniox:`, resp.error_code, resp.error_message);
        return;
      }
      
      const tokens = resp.final_words || []; // Usiamo final_words che è l'equivalente di tokens nel nuovo modello
      for (const t of tokens) {
        if (!t || typeof t.text !== 'string') continue;

        // La documentazione V3 non menziona più '<end>', ma l'endpointing dovrebbe dare un risultato simile.
        // Simuliamo la logica di Edel: accumuliamo parole.
        segment.push(t.text);
      }

      // Se Soniox rileva la fine della frase (pausa), inviamo il segmento accumulato.
      if (resp.endpoint_detected) {
          if (segment.length > 0) {
            const text = segment.join('').replace(/\s+/g, ' ').trim();
            segment = []; // Svuotiamo per la prossima frase
            console.log(`→ Vapi (frase completa): ${text}`);
            vapiSocket.send(JSON.stringify({
              type: 'transcriber-response',
              transcription: text,
              channel: 'customer'
            }));
          }
      }

    } catch (e) {
      console.error(`Errore nel parsing del messaggio Soniox:`, e);
    }
  });

  sonioxSocket.on('error', (err) => console.error(`Errore Soniox:`, err));

  return sonioxSocket;
}

const wss = new WebSocketServer({ port: PORT, perMessageDeflate: false }, () => {
  console.log(`Server proxy in ascolto su ws://localhost:${PORT}`);
});

// Gestore principale
wss.on('connection', (vapiSocket) => {
  console.log('Vapi connesso');
  let sonioxSocket;

  vapiSocket.on('message', (msg, isBinary) => {
    if (!isBinary) {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'start') {
          const sampleRate = data.sampleRate || 16000;
          console.log('Ricevuto messaggio di start, Sample Rate=', sampleRate);
          sonioxSocket = createSonioxSocket(vapiSocket, sampleRate);
        }
      } catch (e) {
        console.error("Errore nel parsing del messaggio JSON da Vapi:", e);
      }
    } else {
      if (sonioxSocket?.readyState === WebSocket.OPEN) {
        const mono = stereoToMonoLeft(msg);
        sonioxSocket.send(mono);
      }
    }
  });

  vapiSocket.on('close', () => {
    console.log('Vapi disconnesso');
    sonioxSocket?.close();
  });
});
