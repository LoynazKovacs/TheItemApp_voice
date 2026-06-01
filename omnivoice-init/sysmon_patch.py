"""System-monitor patch router (injected into OmniVoice by omnivoice-init/Dockerfile).

Upstream OmniVoice keeps the *capture* ASR engine (faster-whisper, used for
push-to-talk dictation) resident for the life of the process and never exposes
it via /model/loaded or /model/unload — so it shows up as a few GB of
"unattributed" VRAM with no off switch. This adds two endpoints:

  GET  /sysmon/asr          → report the capture ASR (model, device, loaded, ~VRAM)
  POST /sysmon/asr/unload   → unload it and free VRAM (reloads lazily next dictation)

Kept deliberately tiny and defensive so it survives upstream changes; if the
internals move, it degrades to loaded=false rather than erroring.
"""
import os
from fastapi import APIRouter

router = APIRouter()

# Rough resident footprint by model (CTranslate2 fp16). Used only for the
# monitor's VRAM attribution; nvidia-smi total remains the source of truth.
_VRAM_ESTIMATE_MB = {
    "Systran/faster-whisper-large-v3": 3100,
    "large-v3": 3100,
    "Systran/faster-whisper-medium": 1500,
    "Systran/faster-whisper-small": 600,
    "mlx-community/whisper-large-v3-turbo": 1600,
}


def _capture_backend():
    try:
        import services.asr_backend as asr
        return asr, asr._capture_backend
    except Exception:
        return None, None


def _is_loaded(b) -> bool:
    if b is None:
        return False
    # faster-whisper / whisperx hold the model in _model (lazy on first use).
    return getattr(b, "_model", None) is not None


def _device() -> str:
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


@router.get("/sysmon/asr")
def asr_status():
    _asr, b = _capture_backend()
    loaded = _is_loaded(b)
    model = (getattr(b, "_model_name", None) if b else None) or os.environ.get(
        "ASR_MODEL_FASTER", "Systran/faster-whisper-large-v3"
    )
    device = _device()
    vram = _VRAM_ESTIMATE_MB.get(model, 3000) if (loaded and device == "cuda") else 0
    return {
        "id": "asr-capture",
        "backend": getattr(b, "id", None) if b else None,
        "model": model,
        "device": device,
        "loaded": loaded,
        "vram_mb": vram,
    }


@router.post("/sysmon/asr/unload")
def asr_unload():
    asr, b = _capture_backend()
    freed = False
    if asr is not None and b is not None:
        try:
            b.unload()
        except Exception:
            pass
        try:
            asr._capture_backend = None
        except Exception:
            pass
        freed = True
    # Best-effort: drop torch's cached allocator blocks too.
    try:
        import services.model_manager as mm
        mm.free_vram()
    except Exception:
        pass
    return {"unloaded": "asr-capture", "success": freed}
