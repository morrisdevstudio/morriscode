import base64
import io
import json
import os
import sys
import time
import wave

from kokoro_onnx import Kokoro


VOICES = {
    "fr": ("ff_siwis", "fr-fr"),
    "en": ("af_heart", "en-us"),
}


def emit(payload):
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def wav_bytes(audio, sample_rate):
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes((audio * 32767).astype("<i2").tobytes())
    return output.getvalue()


def main():
    # Only the CPU onnxruntime package is installed by MorrisCode.
    kokoro = Kokoro(os.environ["MORRISCODE_SPEECH_MODEL"], os.environ["MORRISCODE_SPEECH_VOICES"])
    emit({"type": "ready", "voices": len(kokoro.get_voices())})

    for line in sys.stdin:
        if not line.strip():
            continue
        started = time.perf_counter()
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            language = request.get("language", "fr")
            text = request.get("text", "")
            if language not in VOICES:
                raise ValueError("unsupported language")
            if not isinstance(text, str) or not text.strip():
                raise ValueError("empty text")
            voice, espeak_language = VOICES[language]
            audio, sample_rate = kokoro.create(text, voice=voice, lang=espeak_language)
            payload = wav_bytes(audio, sample_rate)
            emit(
                {
                    "type": "audio",
                    "id": request_id,
                    "audio": base64.b64encode(payload).decode("ascii"),
                    "sampleRate": sample_rate,
                    "generationMs": round((time.perf_counter() - started) * 1000),
                    "durationMs": round(len(audio) / sample_rate * 1000),
                }
            )
        except Exception:
            # Do not return request text or tracebacks: responses can contain
            # private conversation content.
            emit({"type": "error", "id": request_id, "error": "speech synthesis failed"})


if __name__ == "__main__":
    main()
