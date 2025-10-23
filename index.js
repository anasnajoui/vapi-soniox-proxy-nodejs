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
function stereoToMonoRight(buf) {
  const out = Buffer.alloc(buf.length / 2);
  for (let i = 0, j = 0; i < buf.length; i += 4, j += 2) {
    out[j] = buf[i+2];
    out[j+1] = buf[i+3];
  }
  return out;
}

function createSonioxSocket(vapiSocket, sampleRate, who) {
  const sonioxSocket = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket', { perMessageDeflate: false });

  let segment = [];

  sonioxSocket.on('open', () => {
    console.log(`Connesso a Soniox per ${who}`);
    sonioxSocket.send(JSON.stringify({
      api_key: process.env.SONIOX_API_KEY,
      model: "stt-rt-v3",
      language_hints: ["it"],
      audio_format: "pcm_s16le",
      sample_rate: sampleRate,
      num_channels: 1,
      enable_endpoint_detection: true,
      include_nonfinal: false,
    }));
  });

  sonioxSocket.on('message', (sMsg) => {
    try {
      const resp = JSON.parse(sMsg.toString());
      if (resp.error_code) {
        console.error(`Errore Soniox (${who}):`, resp.error_code, resp.error_message);
        return;
      }

      (resp.final_words || []).forEach(t => segment.push(t.text));

      if (resp.endpoint_detected && who === 'customer' && segment.length > 0) {
        const text = segment.join('').trim();
        console.log(`→ Vapi (da ${who}): ${text}`);
        vapiSocket.send(JSON.stringify({
          type: 'transcriber-response',
          transcription: text,
          channel: who
        }));
        segment = [];
      }
    } catch (e) {
      console.error(`Errore nel parsing del messaggio Soniox (${who}):`, e);
    }
  });

  sonioxSocket.on('error', (err) => console.error(`Errore Soniox ${who}:`, err));

  return sonioxSocket;
}

const wss = new WebSocketServer({ port: PORT, perMessageDeflate: false }, () => {
  console.log(`Server proxy in ascolto su ws://localhost:${PORT}`);
});

wss.on('connection', (vapiSocket) => {
  console.log('Vapi connesso');
  let leftSocket, rightSocket;

  vapiSocket.on('message', (msg, isBinary) => {
    if (!isBinary) {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'start') {
          const sampleRate = data.sampleRate || 16000;
          console.log('Ricevuto messaggio di start, Sample Rate=', sampleRate);
          leftSocket = createSonioxSocket(vapiSocket, sampleRate, "customer");
          rightSocket = createSonioxSocket(vapiSocket, sampleRate, "assistant");
        }
      } catch(e) { console.error("Errore parsing JSON Vapi:", e); }
    } else {
      if (leftSocket?.readyState === WebSocket.OPEN) {
        leftSocket.send(stereoToMonoLeft(msg));
      }
      if (rightSocket?.readyState === WebSocket.OPEN) {
        rightSocket.send(stereoToMonoRight(msg));
      }
    }
  });

  vapiSocket.on('close', () => {
    console.log('Vapi disconnesso');
    leftSocket?.close();
    rightSocket?.close();
  });
});
