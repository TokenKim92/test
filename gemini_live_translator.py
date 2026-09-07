import os
import sys
import re
import asyncio
import json
import base64
import math
import struct
import urllib.parse

import pyaudio
import websockets

print("🚀 [배포 검증] 실시간 Gemini Live 연결 구조를 정리하고, URI 파싱 오염을 제거합니다.")

# Gemini Live / BidiGenerateContent는 아래의 native-audio 모델 이름이 실제로 지원됩니다.
# 자세한 모델명은 Google AI Studio / Gemini API docs에서 "Gemini 2.5 Flash Live" 항목을 확인하십시오.
MODEL_NAME = "gemini-2.5-flash-native-audio-preview-12-2025"
CHUNK = 1024
FORMAT = pyaudio.paInt16
CHANNELS = 1
INPUT_RATE = 16000
OUTPUT_RATE = 24000

# 브라우저/OS 환경변수 프록시가 websocket URI를 오염시키는 경우를 방지하기 위해
# 연결 전에 명시적으로 안전한 값만 허용합니다.
for proxy_var in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy"):
    os.environ.pop(proxy_var, None)

p = pyaudio.PyAudio()
mic_queue = asyncio.Queue()
VOICE_THRESHOLD = 120


def build_live_uri(api_key: str) -> str:
    """Gemini Live BidiGenerateContent용 WebSocket URI를 안전하게 조립한다."""
    if not api_key:
        raise RuntimeError(
            "GEMINI_API_KEY가 설정되지 않았습니다. "
            "PowerShell: $env:GEMINI_API_KEY='YOUR_KEY'; python gemini_live_translator.py"
        )

    endpoint = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
    params = urllib.parse.urlencode({"key": api_key})
    uri = f"{endpoint}?{params}"
    parsed = urllib.parse.urlparse(uri)
    if parsed.scheme != "wss" or not parsed.hostname:
        raise ValueError(f"잘못된 Gemini Live URI가 생성되었습니다: {uri!r}")
    return uri

def should_suppress_translation_text(text: str) -> bool:
    """모델의 설명형 사고문을 화면에서 걸러내고 순수 번역만 보여준다."""
    cleaned = text.strip()
    if not cleaned:
        return True
    lower = cleaned.lower()
    if re.search(r"\b(i|i'm|I've|i have|interpreting|clarifying|translation of|this sermon context|best translated|determine|determined)\b", lower):
        return True
    if lower.startswith(("interpreting", "clarifying", "the translation", "translation of", "i'm interpreting", "i have determined")):
        return True
    return False


def calculate_volume_bar(data):
    """마이크 입력 신호 크기를 계산하여 텍스트 막대그래프로 시각화"""
    count = len(data) // 2
    if count == 0: return ""
    shorts = struct.unpack(f"{count}h", data)
    sum_squares = sum(s * s for s in shorts)
    rms = math.sqrt(sum_squares / count)
    level = int(rms / 500)
    level = min(level, 20)
    return "■" * level + "░" * (20 - level)

def mic_blocking_callback(in_data, frame_count, time_info, status):
    """Windows 오디오 캡처 스레드와 비동기 루프 연동 콜백"""
    if 'loop' in globals():
        loop.call_soon_threadsafe(mic_queue.put_nowait, in_data)
    return (None, pyaudio.paContinue)

async def audio_mic_sender(websocket):
    print("\n🎙️ 마이크 스트림이 정상 구동되었습니다. 한국어로 편하게 말씀하세요...")
    try:
        while True:
            data = await mic_queue.get()
            v_bar = calculate_volume_bar(data)
            print(f"\r🔊 마이크 신호 세기: [{v_bar}]", end="", flush=True)
            
            base64_audio = base64.b64encode(data).decode('utf-8')
            payload = {
                "realtimeInput": {
                    "mediaChunks": [
                        {
                            "mimeType": "audio/pcm;rate=16000",
                            "data": base64_audio
                        }
                    ]
                }
            }
            await websocket.send(json.dumps(payload))
            mic_queue.task_done()
    except asyncio.CancelledError:
        pass

async def audio_speaker_receiver(websocket):
    """구글에서 넘어온 오디오 및 자막 데이터를 수신 처리"""
    try:
        async for message in websocket:
            response = json.loads(message)
            if "serverContent" not in response:
                continue

            model_turn = response["serverContent"].get("modelTurn", {})
            parts = model_turn.get("parts", [])
            for part in parts:
                text = part.get("text", "")
                if text:
                    cleaned = text.strip()
                    if should_suppress_translation_text(cleaned):
                        continue
                    print(f"\n🤖 독일어 번역 자막: {cleaned}")

                inline_data = part.get("inlineData")
                if inline_data and inline_data.get("mimeType", "").startswith("audio/pcm"):
                    audio_data = base64.b64decode(inline_data["data"])
                    await loop.run_in_executor(None, output_stream.write, audio_data)
    except websockets.exceptions.ConnectionClosedError as e:
        print(f"\n❌ 구글 서버 세션 종료: {e}")
    except asyncio.CancelledError:
        pass

async def main():
    global loop, output_stream, native_input_stream
    loop = asyncio.get_running_loop()
    try:
        output_stream = p.open(
            format=FORMAT,
            channels=CHANNELS,
            rate=OUTPUT_RATE,
            output=True,
            frames_per_buffer=CHUNK,
        )
    except Exception as e:
        print(f"❌ 오디오 출력 장치 초기화 실패: {e}")
        p.terminate()
        sys.exit(1)

    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    try:
        TARGET_URI = build_live_uri(api_key)
    except Exception as exc:
        print(f"❌ Gemini API 키가 없습니다: {exc}")
        sys.exit(1)

    print(f"🔗 Gemini Live 엔드포인트로 연결 시도: {TARGET_URI}")

    try:
        async with websockets.connect(
            TARGET_URI,
            ping_interval=None,
            ping_timeout=None,
            open_timeout=15,
            close_timeout=5,
            proxy=None,
            additional_headers={"User-Agent": "GeminiLiveTranslator/1.0"},
        ) as websocket:
            print("✅ 구글 AI 백엔드와 양방향 웹소켓 터널링 완료!")

            setup_message = {
                "setup": {
                    "model": f"models/{MODEL_NAME}",
                    "generationConfig": {
                        "responseModalities": ["AUDIO"],
                        "temperature": 0.1,
                        "topP": 0.2,
                        "speechConfig": {
                            "voiceConfig": {
                                "prebuiltVoiceConfig": {
                                    "voice_name": "Aoede"
                                }
                            }
                        }
                    },
                    "systemInstruction": {
                        "parts": [{
                            "text": "You are a professional real-time simultaneous interpreter for a church sermon. Translate Korean speech into natural spoken German instantly. Follow these rules without exception: output only the direct German translation, never commentary, never explanations, never self-reference, never 'I have determined' or 'I think', never mention your interpretation process, never summarize the input, never add greetings or closing remarks, and never output English text. If the Korean input is fragmented, translate only the meaningful German words and keep the result short, natural, and direct."
                        }]
                    }
                }
            }
            await websocket.send(json.dumps(setup_message))
            print("⚙️ 실시간 동시통역 프로토콜 핸드셰이크 세션 수립 완료.")

            native_input_stream = p.open(
                format=FORMAT,
                channels=CHANNELS,
                rate=INPUT_RATE,
                input=True,
                frames_per_buffer=CHUNK,
                stream_callback=mic_blocking_callback,
            )

            sender_task = asyncio.create_task(audio_mic_sender(websocket))
            receiver_task = asyncio.create_task(audio_speaker_receiver(websocket))
            await asyncio.gather(sender_task, receiver_task)
    except websockets.exceptions.InvalidURI as exc:
        print(f"❌ WebSocket URI가 유효하지 않습니다: {exc}")
        raise
    except Exception as exc:
        print(f"❌ Gemini Live 연결 실패: {exc}")
        raise

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n🛑 동시통역 엔진을 오프라인 전환합니다.")
    finally:
        if 'native_input_stream' in globals() and native_input_stream is not None:
            try:
                if native_input_stream.is_active():
                    native_input_stream.stop_stream()
                native_input_stream.close()
            except Exception:
                pass
        if 'output_stream' in globals() and output_stream is not None:
            try:
                if output_stream.is_active():
                    output_stream.stop_stream()
                output_stream.close()
            except Exception:
                pass
        try:
            p.terminate()
        except Exception:
            pass