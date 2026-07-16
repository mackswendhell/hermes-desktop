import gc
import io
import os
import threading
import time
import wave
from pathlib import Path
from tempfile import NamedTemporaryFile

os.environ.setdefault("COQUI_TOS_AGREED", "1")

import torch

# ctranslate2 (faster-whisper) precisa achar as DLLs de cuDNN/cuBLAS que vêm com o torch
# (add_dll_directory só existe no Windows)
_torch_lib = Path(torch.__file__).parent / "lib"
if hasattr(os, "add_dll_directory") and _torch_lib.is_dir():
    os.add_dll_directory(str(_torch_lib))

import numpy as np
from fastapi import FastAPI, UploadFile, File
from fastapi.responses import Response
from pydantic import BaseModel

PORT = int(os.environ.get("VOICE_PORT", "8756"))
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
TTS_SPEAKER = os.environ.get("TTS_SPEAKER", "Ana Florence")
IDLE_UNLOAD_S = int(os.environ.get("IDLE_UNLOAD_S", "600"))

app = FastAPI(title="Hermes Voice Server")

_stt = None
_tts = None
_last_used = time.time()
# os modelos não suportam inferência concorrente — uma trava serializa o uso da GPU
_gpu_lock = threading.Lock()


def _touch():
    global _last_used
    _last_used = time.time()


def _idle_watchdog():
    # libera a VRAM depois de IDLE_UNLOAD_S sem uso; recarrega no próximo pedido.
    # IDLE_UNLOAD_S <= 0 desativa a hibernação.
    global _stt, _tts
    while True:
        time.sleep(60)
        if IDLE_UNLOAD_S <= 0:
            continue
        if (_stt is not None or _tts is not None) and time.time() - _last_used > IDLE_UNLOAD_S:
            with _gpu_lock:
                _stt = None
                _tts = None
                gc.collect()
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            print(f"[idle] modelos descarregados da VRAM após {IDLE_UNLOAD_S}s sem uso")


threading.Thread(target=_idle_watchdog, daemon=True).start()


def get_stt():
    global _stt
    if _stt is None:
        from faster_whisper import WhisperModel

        if DEVICE == "cuda":
            try:
                _stt = WhisperModel("medium", device="cuda", compute_type="float16")
            except Exception as e:
                print(f"[stt] CUDA falhou ({e}), caindo para CPU int8")
                _stt = WhisperModel("medium", device="cpu", compute_type="int8")
        else:
            _stt = WhisperModel("medium", device="cpu", compute_type="int8")
    return _stt


def get_tts():
    global _tts
    if _tts is None:
        from TTS.api import TTS

        _tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(DEVICE)
    return _tts


@app.get("/health")
def health():
    return {
        "status": "ok",
        "device": DEVICE,
        "stt_loaded": _stt is not None,
        "tts_loaded": _tts is not None,
    }


@app.post("/warmup")
def warmup():
    _touch()
    get_stt()
    get_tts()
    return {"status": "ok", "device": DEVICE}


@app.get("/speakers")
def speakers():
    engine = get_tts()
    names = []
    try:
        names = list(engine.synthesizer.tts_model.speaker_manager.speaker_names)
    except Exception:
        names = engine.speakers or []
    return {"speakers": sorted(names)}


@app.post("/stt")
async def stt(audio: UploadFile = File(...)):
    _touch()
    data = await audio.read()
    suffix = Path(audio.filename or "audio.webm").suffix or ".webm"
    with NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(data)
        tmp_path = f.name
    try:
        with _gpu_lock:
            segments, info = get_stt().transcribe(
                tmp_path, language="pt", beam_size=2, vad_filter=True
            )
            text = " ".join(s.text.strip() for s in segments).strip()
    finally:
        os.unlink(tmp_path)
    return {"text": text, "duration": round(info.duration, 2)}


class TtsRequest(BaseModel):
    text: str
    speaker: str | None = None
    language: str = "pt"


@app.post("/tts")
def tts(req: TtsRequest):
    _touch()
    with _gpu_lock:
        engine = get_tts()
        wav = engine.tts(
            text=req.text,
            speaker=req.speaker or TTS_SPEAKER,
            language=req.language,
        )
    samples = np.array(wav, dtype=np.float32)
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(pcm.tobytes())
    return Response(content=buf.getvalue(), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")
