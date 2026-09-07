const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
require('dotenv').config();

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025';
const AUDIO_DEVICE = process.env.AUDIO_DEVICE || '';
const TURN_SILENCE_MS = Number(process.env.TURN_SILENCE_MS || 180);
const CLIENT_FILES_DIR = path.join(__dirname, 'public');

if (!API_KEY) {
  console.error('Missing GEMINI_API_KEY. Create a .env file based on .env.example');
  process.exit(1);
}

const clients = new Set();
let liveSocket = null;
let micRecorder = null;
let shuttingDown = false;

function resolveSoxExecutable() {
  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  const winGetRoot = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');

  const matches = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) {
      return;
    }

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase() === 'sox.exe') {
        matches.push(full);
      }
    }
  }

  walk(winGetRoot);

  if (matches.length > 0) {
    const chosen = matches[0];
    const dir = path.dirname(chosen);
    const currentPath = process.env.PATH || '';
    process.env.PATH = `${dir}${path.delimiter}${currentPath}`;
    return chosen;
  }

  return 'sox';
}

const SOX_EXECUTABLE = resolveSoxExecutable();
console.log(`[audio] SoX binary: ${SOX_EXECUTABLE}`);

function buildGeminiUri() {
  const endpoint = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
  const params = new URLSearchParams({ key: API_KEY }).toString();
  return `${endpoint}?${params}`;
}

function startMicrophoneCapture() {
  const inputDevice = AUDIO_DEVICE || 'default';
  const args = [
    '-t', 'waveaudio', inputDevice,
    '--buffer', '2048',
    '--no-show-progress',
    '--rate', '16000',
    '--channels', '1',
    '--encoding', 'signed-integer',
    '--bits', '16',
    '-t', 'raw', '-'
  ];
  const processHandle = spawn(SOX_EXECUTABLE, args, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let errorOutput = '';
  let stopping = false;
  processHandle.stderr.on('data', (chunk) => {
    errorOutput += chunk.toString();
  });
  processHandle.on('error', (error) => {
    processHandle.stdout.emit('error', error);
  });
  processHandle.on('close', (code) => {
    if (code !== 0 && !stopping) {
      processHandle.stdout.emit('error', `${SOX_EXECUTABLE} has exited with error code ${code}. ${errorOutput.trim()}`);
    }
  });

  return {
    process: processHandle,
    stream: () => processHandle.stdout,
    stop: () => {
      stopping = true;
      processHandle.kill();
    }
  };
}

function serveStaticFile(res, filePath) {
  const resolved = path.resolve(CLIENT_FILES_DIR, filePath);
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const ext = path.extname(resolved).toLowerCase();
    const contentType = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.ico': 'image/x-icon'
    }[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, service: 'church-live-translator' }));
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    serveStaticFile(res, 'index.html');
    return;
  }

  if (url.pathname.startsWith('/')) {
    serveStaticFile(res, url.pathname.replace(/^\//, ''));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

const wss = new WebSocket.Server({ server: httpServer, path: '/ws' });

httpServer.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`포트 ${PORT}가 이미 사용 중입니다. 기존 서버를 종료하거나 .env의 PORT를 변경하세요.`);
    process.exitCode = 1;
    return;
  }

  console.error('HTTP 서버 오류:', error);
  process.exitCode = 1;
});

wss.on('error', (error) => {
  console.error('WebSocket 서버 오류:', error.message || error);
});

function broadcastBinary(buffer) {
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(buffer);
    }
  });
}

function broadcastText(text) {
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ text }));
    }
  });
}

function shouldSuppressTranslationText(text) {
  const cleaned = text.trim();
  if (!cleaned) {
    return true;
  }

  return /\b(i|i'm|i've|i have|interpreting|clarifying|translation|translated|this sermon context|best translated|natural|equivalent|captures|essence|determine|determined)\b/i.test(cleaned)
    || /^(the translation|translation of|interpreting|clarifying|i'm interpreting|i have determined|the most natural)/i.test(cleaned);
}

function connectGeminiLive() {
  const uri = buildGeminiUri();
  liveSocket = new WebSocket(uri);

  liveSocket.on('open', () => {
    console.log('Gemini Live WebSocket connected.');

    const setupMessage = {
      setup: {
        model: `models/${MODEL_NAME}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          temperature: 0.1,
          topP: 0.2,
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voice_name: 'Aoede'
              }
            }
          }
        },
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
            endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
            prefixPaddingMs: 20,
            silenceDurationMs: TURN_SILENCE_MS
          }
        },
        systemInstruction: {
          parts: [
            {
              text: 'You are a professional real-time simultaneous interpreter for a church sermon. Translate Korean sermon speech into natural spoken German with the lowest possible latency. Begin translating as soon as a short phrase or meaningful fragment is clear; do not wait for the speaker to finish a full sentence or paragraph. Output ONLY the direct German translation. NEVER output explanations, analysis, self-reference, English commentary, translation notes, quotation marks, preambles, or extra chatter. Return the German translation itself, even for short or fragmented input. If the input is incomplete, translate only the meaningful German phrase directly.'
            }
          ]
        }
      }
    };

    liveSocket.send(JSON.stringify(setupMessage));

    try {
      micRecorder = startMicrophoneCapture();

      const micStream = micRecorder.stream();
      micStream.on('data', (chunk) => {
        if (liveSocket && liveSocket.readyState === WebSocket.OPEN) {
          const payload = {
            realtimeInput: {
              mediaChunks: [
                {
                  mimeType: 'audio/pcm;rate=16000',
                  data: chunk.toString('base64')
                }
              ]
            }
          };

          liveSocket.send(JSON.stringify(payload));
        }
      });

      micStream.on('error', (error) => {
        console.error('Microphone capture error:', error);
        if (String(error).includes('no default audio device configured')) {
          console.error('Windows 기본 녹음 장치가 없습니다. 설정 > 시스템 > 소리 > 입력에서 마이크를 선택하고 다시 실행하세요.');
        }
      });
    } catch (error) {
      console.error('Unable to start microphone capture:', error.message || error);
      console.error('Install SoX on Windows: https://sourceforge.net/projects/sox/files/sox/');
      process.exit(1);
    }
  });

  liveSocket.on('message', (raw) => {
    try {
      const message = raw.toString();
      const decoded = JSON.parse(message);

      if (!decoded || !decoded.serverContent) {
        return;
      }

      const modelTurn = decoded.serverContent.modelTurn || {};
      const parts = modelTurn.parts || [];

      parts.forEach((part) => {
        if (part.text) {
          const text = String(part.text).trim();
          if (text && !shouldSuppressTranslationText(text)) {
            console.log('[Gemini text]', text);
            broadcastText(text);
          }
        }

        if (part.inlineData && part.inlineData.mimeType && part.inlineData.mimeType.startsWith('audio/pcm')) {
          try {
            const audioBytes = Buffer.from(part.inlineData.data, 'base64');
            broadcastBinary(audioBytes);
          } catch (audioError) {
            console.error('Failed to decode inline audio chunk:', audioError);
          }
        }
      });
    } catch (parseError) {
      console.warn('Received non-JSON Gemini payload:', raw.toString());
    }
  });

  liveSocket.on('error', (error) => {
    console.error('Gemini Live WebSocket error:', error.message || error);
  });

  liveSocket.on('close', (code, reason) => {
    console.log(`Gemini Live WebSocket closed (${code}): ${reason || 'no reason provided'}`);
    if (micRecorder) {
      try {
        micRecorder.stop();
      } catch (_) {}
      micRecorder = null;
    }
    if (!shuttingDown) {
      setTimeout(connectGeminiLive, 2000);
    }
  });
}

wss.on('connection', (socket) => {
  clients.add(socket);
  console.log('New client connected to local broadcast WebSocket.');

  socket.on('close', () => {
    clients.delete(socket);
  });
});

httpServer.listen(PORT, HOST, () => {
  console.log(`HTTP server listening on http://${HOST}:${PORT}`);
  console.log(`Broadcast WebSocket available at ws://${HOST}:${PORT}/ws`);
  connectGeminiLive();
});

process.on('SIGINT', () => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log('Shutting down gracefully...');

  if (micRecorder) {
    try {
      micRecorder.stop();
    } catch (_) {}
  }

  if (liveSocket && (liveSocket.readyState === WebSocket.OPEN || liveSocket.readyState === WebSocket.CONNECTING)) {
    liveSocket.close();
  }

  clients.forEach((client) => {
    try {
      client.close(1001, 'Server shutting down');
    } catch (_) {
      client.terminate();
    }
  });

  const forceCloseTimer = setTimeout(() => {
    clients.forEach((client) => {
      if (client.readyState !== WebSocket.CLOSED) {
        client.terminate();
      }
    });
  }, 1000);
  forceCloseTimer.unref();

  wss.close(() => {
    clearTimeout(forceCloseTimer);
    httpServer.close(() => process.exit(0));
  });
});
