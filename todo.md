
# 📋 Roo Code AI 동시통역 시스템 구축 요구 명세서 (Spec Sheet)

## 1. 프로젝트 개요 (Project Overview)

- **목적:** 교회 예배 설교용 한국어 ➡️ 독일어 AI 실시간 초저지연 동시통역 시스템 구축.
- **방식:** 별도의 하드웨어 수신기나 앱 설치 장벽을 없애기 위해, 성도들이 교회 내부 와이파이(Wi-Fi)에 접속한 뒤 스마트폰으로 **주보의 QR코드를 스캔하면 즉시 웹 브라우저로 통역을 들을 수 있는 웹소켓 기반 초저지연 스트리밍 구조** 구현.

---

## 2. 아키텍처 큰 그림 (The Big Picture)

추가적인 버퍼 지연을 유발하는 무거운 미디어 스트리밍 프로토콜(HLS, DASH 등)을 과감히 생략하고, **메모리 상에서 바이너리 오디오 청크를 다이렉트로 관통시키는 초저지연 웹소켓 파이프라인** 구조입니다.

```text
[목사님 마이크] ➔ [디지털 믹서] ➔ [방송실 노트북 (Node.js 백엔드)] ➔ [Gemini Live API]
                                                 │ (독일어 바이너리 응답 수신)
                                                 ▼
[성도 스마트폰 웹 브라우저] ◄── [로컬 와이파이 웹소켓 공유] ◄── [노트북 로컬 웹 서버]
 (Web Audio API로 즉시 재생)
```

---

## 3. 상세 기술 스택 (Tech Stack)

- **언어 및 런타임:** Node.js (Windows 11 환경 환경)
- **오디오 캡처 라이브러리:** `node-record-lpcm16` (SoX 엔진 기반으로 목사님 마이크 소리를 16kHz, 16-bit, Mono PCM으로 실시간 인터셉트)
- **AI 실시간 API 프로토콜:** Google Gemini Live API (`BidiGenerateContent` v1beta 웹소켓 프로토콜)
- **로컬 배포 인프라:** `ws` (Node.js 경량 웹소켓 서버를 열어 동일 와이파이 망의 성도들에게 바이너리 브로드캐스트)
- **프론트엔드 클라이언트:** **Pure Vanilla JS / HTML5** (싱글 페이지 구조)
- **클라이언트 재생 엔진:** **Web Audio API (`AudioContext`)** (들어오는 오디오 청크를 브라우저 오디오 타임라인에 직접 밀어 넣는 큐잉 구조)

---

## 4. 컴포넌트별 세부 구현 요구사항 (Component Requirements)

### ① 백엔드 (Node.js)

1. **마이크 캡처 및 AI 연동 스트리밍**
   - 로컬 마이크/오디오 인터페이스 인풋 스트림을 열어 PCM 데이터를 20ms~40ms 단위의 청크로 쪼갭니다.
   - 구글 제미나이 멀티모달 라이브 API 공식 엔드포인트(`wss://://googleapis.com`)에 연결합니다.
   - 카멜 케이스 공식 규격인 `realtimeInput.mediaChunks` 포맷에 맞춰 base64 데이터를 실시간 업스트림합니다.
   - AI로부터 실시간 다운스트림되는 독일어 오디오 바이너리 청크(`inlineData.data`) 및 자막 텍스트(`text`)를 수신합니다.
2. **로컬 웹소켓 브로드캐스트 및 웹 서버**
   - 수신된 독일어 바이너리 청크를 어떠한 내부 서버 버퍼 적재(Buffering) 없이, 로컬 서버 웹소켓에 접속된 모든 성도의 스마트폰 채널로 즉시 브로드캐스트(Broadcast)합니다.
   - 성도들이 접속할 프론트엔드 HTML 플레이어 페이지를 가볍게 호스팅(Express 혹은 가벼운 HTTP 내장 서버)합니다.

### ② 프론트엔드 (Vanilla JS / HTML5)

1. **사용자 인터페이스 (UI)**
   - 앱 설치 없이 브라우저(Safari, Chrome 등)에서 즉시 열려야 합니다.
   - 브라우저 보안 정책(Autoplay Policy)을 우회하기 위해 사용자가 `[▶ 통역 듣기 시작]` 버튼을 누르면 `AudioContext`가 활성화되는 구조로 만듭니다.
2. **초저지연 웹 플레이어 엔진**
   - 웹소켓을 통해 실시간으로 들어오는 바이너리 청크를 `AudioContext.currentTime` 기준으로 **선형 스케줄링 큐잉(Linear Queuing)** 처리합니다.
   - 와이파이 패킷 흔들림(Jitter)으로 인해 소리가 밀리거나 끊기지 않도록 정확한 미래 타임스탬프를 계산하여 순서대로 예약 배치(`audioBufferSourceNode.start(nextPlayTime)`)하는 알고리즘을 프론트엔드 자바스크립트에 반영해 주세요.

---

## 5. Roo Code 실행 프롬프트 (Prompt for Roo Code)

> **아래 내용을 복사하여 Roo Code에 그대로 입력하세요:**

Please build a real-time, ultra-low latency AI audio translation streaming system using Node.js for a church sermon (Korean to German).

Requirements:

1. Capture local microphone input (Pastor's sermon) using node-record-lpcm16 (16kHz, 16bit, Mono PCM).
2. Connect to Google Gemini Multimodal Live API via a bidirectional WebSocket (v1beta BidiGenerateContent endpoint) to send Korean audio chunks using the correct camelCase payload format, and receive translated German audio chunks and text subtitles in real-time.
3. Use model 'gemini-2.5-flash' and voice config 'Aoede'. Add system instructions specifying that it must act as a professional real-time simultaneous church interpreter, outputting ONLY the direct translation.
4. Create a lightweight local Node.js WebSocket server to immediately broadcast the incoming German binary audio chunks to all connected smartphone clients without any server-side buffering.
5. Host a single plain Vanilla HTML5/JS page. When a user (congregation member) connects via local Wi-Fi, they should click a "[Start Listening]" button to resume the Web Audio API (AudioContext).
6. Implement strict linear audio sample scheduling on the client-side JavaScript to pull raw binary data from the WebSocket and queue it smoothly into the AudioContext timeline, ensuring ultra-low latency (under 100ms streaming lag) and handling network jitter.

Please generate the complete backend index.js code and the embedded frontend html code in a clean, production-ready structure.

---

## 내일 작업: 설교 중간 번역 및 ChatGPT/OpenAI 비교 테스트

- 현재 문제: 설교자가 말을 멈출 때까지 Gemini가 긴 발화를 하나의 턴으로 처리하여 번역 시작이 늦어질 수 있음.
- 목표: 발화 종료를 기다리지 않고 1~2초 단위 또는 의미 단위의 짧은 문맥이 완성될 때마다 한국어를 독일어로 번역하고 음성을 스트리밍함.
- Gemini 경로: 오디오 VAD/청크 분할, 최근 문맥 유지, 이미 번역한 구간 중복 방지, 부분 번역 품질을 테스트함.
- OpenAI 경로: OpenAI Realtime API의 `input_audio_buffer.append`, VAD/turn detection, `response.audio.delta`, transcript 이벤트를 사용해 동일한 로컬 WebSocket 구조에 연결함.
- 비교 기준: 첫 음성 응답까지의 시간, 문장 중간 응답 여부, 독일어 번역 품질, 끊김/중복, API 비용, 장시간 설교 안정성.
- 주의: ChatGPT 웹 무료 계정과 OpenAI API는 별도임. Realtime API 테스트에는 API 키와 API 사용 권한/결제 설정이 필요하며 무료 사용량 제공 여부는 계정과 시점에 따라 달라질 수 있음.
