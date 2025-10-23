import WebSocket, { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
dotenv.config();

const PORT = process.env.PORT || 3000;

function stereoToMonoLeft(buf) {
  const out = Buffer.alloc(buf.length / 2);
  for (let i = 0, j = 0; i < buf.length; i += 4, j += 2) {
    out[j] = buf[i];
    out[j+1] = buf[i+1];
  }
  return out;
}

function createSonioxSocket(vapiSocket, sampleRate) {
  const sonioxSocket = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket', { perMessageDeflate: false });

  let finalTranscript = ''; // Tiene traccia del testo confermato

  sonioxSocket.on('open', () => {
    console.log(`Connesso a Soniox per il cliente`);
    sonioxSocket.send(JSON.stringify({
      api_key: process.env.SONIOX_API_KEY,
      model: "stt-rt-v3",
      language_hints: ["it"],
      audio_format: "pcm_s16le",
      sample_rate: sampleRate,
      num_channels: 1,
      enable_endpoint_detection: true,
      include_nonfinal: true, // Chiediamo a Soniox anche i risultati provvisori
    }));
  });

  sonioxSocket.on('message', (sMsg) => {
    try {
      const resp = JSON.parse(sMsg.toString());
      if (resp.error_code) {
        console.error(`Errore Soniox:`, resp.error_code, resp.error_message);
        return;
      }

      // Ricostruiamo la trascrizione finale stabile
      finalTranscript = (resp.final_words || []).map(w => w.text).join('');
      // Prendiamo la parte provvisoria attuale
      const interimTranscript = (resp.nonfinal_words || []).map(w => w.text).join('');

      // La trascrizione completa da inviare a Vapi è la parte finale + quella provvisoria
      const fullTranscript = (finalTranscript + interimTranscript).trim();

      if (fullTranscript) {
        console.log(`~> Vapi: ${fullTranscript}`);
        vapiSocket.send(JSON.stringify({
          type: 'transcriber-response',
          transcription: fullTranscript,
          channel: 'customer'
        }));
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
