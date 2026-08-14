import gc
import io
import os
import threading
import time
import wave
from pathlib import Path

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
SAMPLE_RATE = 24000

app = FastAPI(title="Hermes Voice Server")

_stt = None
_tts = None
_last_used = time.time()
# os modelos não suportam inferência concorrente — uma trava serializa o uso da GPU
_gpu_lock = threading.Lock()
# montar o XTTS custa ~15 s e é trabalho de CPU: fica fora do _gpu_lock, senão uma
# transcrição que chegue durante a carga esperaria por ela inteira
_tts_load_lock = threading.Lock()


def _touch():
    global _last_used
    _last_used = time.time()


def _preimport():
    # importar faster_whisper e TTS custa ~4 s; pagar isso no arranque tira esse tempo do
    # primeiro pedido depois de a hibernação descarregar os modelos
    try:
        import faster_whisper  # noqa: F401
        from TTS.api import TTS  # noqa: F401
    except Exception as e:  # ambiente sem os pacotes: o erro real aparece no primeiro uso
        print(f"[preload] imports adiados: {e}")


threading.Thread(target=_preimport, daemon=True).start()


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


# sem trava própria: quem chama já está segurando o _gpu_lock (o modelo nasce no device)
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
    if _tts is not None:
        return _tts
    with _tts_load_lock:
        if _tts is None:
            from TTS.api import TTS

            t0 = time.time()
            engine = TTS("tts_models/multilingual/multi-dataset/xtts_v2")
            # o único trecho que encosta na GPU é a mudança de device
            with _gpu_lock:
                engine.to(DEVICE)
            _tts = engine
            print(f"[tts] modelo carregado em {time.time() - t0:.1f}s ({DEVICE})")
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
def warmup(what: str = "all"):
    # em estágios: o app pede "stt" quando começa a gravar e "tts" quando manda a pergunta
    # para o Hermes, então cada carga acontece atrás de uma espera que já existia
    _touch()
    if what in ("all", "stt"):
        with _gpu_lock:
            get_stt()
    if what in ("all", "tts"):
        get_tts()
    return {
        "status": "ok",
        "device": DEVICE,
        "stt_loaded": _stt is not None,
        "tts_loaded": _tts is not None,
    }


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
    with _gpu_lock:
        segments, info = get_stt().transcribe(
            io.BytesIO(data), language="pt", beam_size=2, vad_filter=True
        )
        text = " ".join(s.text.strip() for s in segments).strip()
    return {"text": text, "duration": round(info.duration, 2)}


class TtsRequest(BaseModel):
    text: str
    speaker: str | None = None
    language: str = "pt"


def _pcm(wav) -> bytes:
    samples = np.asarray(wav, dtype=np.float32)
    return (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16).tobytes()


@app.post("/tts")
def tts(req: TtsRequest):
    _touch()
    engine = get_tts()
    with _gpu_lock:
        wav = engine.tts(
            text=req.text,
            speaker=req.speaker or TTS_SPEAKER,
            language=req.language,
        )
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(_pcm(wav))
    return Response(content=buf.getvalue(), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")
