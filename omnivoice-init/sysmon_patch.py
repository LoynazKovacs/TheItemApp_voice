"""System-monitor + device-control patch router (injected into OmniVoice by
omnivoice-init/Dockerfile).

Two concerns live here:

1. Capture-ASR attribution. Upstream OmniVoice keeps the *capture* ASR engine
   (faster-whisper, used for push-to-talk dictation) resident for the life of
   the process and never exposes it via /model/loaded or /model/unload — so it
   shows up as a few GB of "unattributed" VRAM with no off switch.

     GET  /sysmon/asr          → report the capture ASR (model, device, loaded, ~VRAM)
     POST /sysmon/asr/unload   → unload it and free VRAM (reloads lazily next dictation)

2. Runtime GPU/CPU device control. The whole engine (TTS via
   model_manager.get_best_device, ASR via each backend's torch.cuda.is_available
   check) keys its device choice off ONE lever: torch.cuda.is_available(). We
   wrap that single function so a runtime override forces the entire engine onto
   CPU (or back onto the GPU) consistently, without a container restart and
   without creating a CUDA context while in CPU mode.

     GET  /sysmon/engine          → effective device, forced device, loaded/loading, VRAM
     POST /sysmon/engine/device   → {"device":"cpu"|"cuda"} unload → switch → reload
     POST /sysmon/engine/load     → preload the TTS model on the current device
     POST /sysmon/engine/unload   → unload TTS + capture ASR and free VRAM

   The chosen device is persisted to OMNIVOICE_DATA_DIR/device_override so it
   survives container restarts. Boot precedence: persisted file > env
   OMNIVOICE_FORCE_DEVICE > auto (real detection). To toggle to "cuda" the
   container must have been started with the GPU visible
   (CUDA_VISIBLE_DEVICES not empty); otherwise the switch is rejected with 409.

Kept deliberately defensive so it survives upstream changes; if internals move
it degrades (loaded=false / best-effort) rather than erroring.
"""
import os
import logging

from fastapi import APIRouter
from fastapi.responses import JSONResponse

logger = logging.getLogger("sysmon_patch")
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

# ── Device override lever ───────────────────────────────────────────────────
# _forced["device"] is one of: "cpu" (force CPU), "cuda" (prefer GPU), or
# None (auto / real detection). The wrapped torch.cuda.is_available honours it.
_forced = {"device": None}


def _override_path() -> str:
    data_dir = os.environ.get("OMNIVOICE_DATA_DIR", "/app/omnivoice_data")
    return os.path.join(data_dir, "device_override")


def _read_persisted_device():
    try:
        with open(_override_path(), "r", encoding="utf-8") as fh:
            val = fh.read().strip().lower()
        return val if val in ("cpu", "cuda", "auto") else None
    except Exception:
        return None


def _persist_device(value: str) -> None:
    try:
        os.makedirs(os.path.dirname(_override_path()), exist_ok=True)
        with open(_override_path(), "w", encoding="utf-8") as fh:
            fh.write(value)
    except Exception as exc:  # pragma: no cover - best effort
        logger.warning("Could not persist device override: %s", exc)


def _norm_device(value):
    if not value:
        return None
    v = str(value).strip().lower()
    if v in ("cpu",):
        return "cpu"
    if v in ("cuda", "gpu"):
        return "cuda"
    return None  # "auto" / anything else → no override


def _install_cuda_lever():
    """Wrap torch.cuda.is_available so a forced-CPU override hides the GPU from
    the entire engine. Idempotent. Importing torch does NOT create a CUDA
    context, and while forced to CPU the real is_available is never called, so
    no context is created and no VRAM is held."""
    try:
        import torch
    except Exception as exc:
        logger.warning("torch unavailable; device lever inactive: %s", exc)
        return
    if getattr(torch.cuda, "_sysmon_real_is_available", None) is not None:
        return  # already installed
    real = torch.cuda.is_available
    torch.cuda._sysmon_real_is_available = real

    def _patched_is_available():
        if _forced["device"] == "cpu":
            return False
        return real()

    torch.cuda.is_available = _patched_is_available
    logger.info("Device lever installed (torch.cuda.is_available wrapped).")


def _real_cuda_available() -> bool:
    try:
        import torch
        real = getattr(torch.cuda, "_sysmon_real_is_available", None) or torch.cuda.is_available
        return bool(real())
    except Exception:
        return False


# Resolve the boot device: persisted file > env OMNIVOICE_FORCE_DEVICE > auto.
_boot_device = _read_persisted_device() or _norm_device(os.environ.get("OMNIVOICE_FORCE_DEVICE"))
_forced["device"] = _norm_device(_boot_device)
_install_cuda_lever()
logger.info("OmniVoice device override at boot: %s", _forced["device"] or "auto")


# ── Capture-ASR helpers (unchanged behaviour) ──────────────────────────────
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


# ── Engine device control ───────────────────────────────────────────────────
def _effective_device() -> str:
    """What the engine would load on right now (honours the override)."""
    try:
        import services.model_manager as mm
        return mm.get_best_device()
    except Exception:
        if _forced["device"] == "cpu":
            return "cpu"
        return "cuda" if _real_cuda_available() else "cpu"


def _vram_mb():
    """(used_mb, total_mb) on the GPU, or (None, None).

    IMPORTANT: skip this entirely while forced to CPU. `mem_get_info()` is a
    CUDA runtime call that creates a primary context (and its driver-overhead
    VRAM) on the current device — calling it in CPU mode would defeat the whole
    point of being on CPU. Device-wide GPU totals are available from the System
    Manager app / nvidia-smi anyway. Only probe when we're actually on the GPU."""
    if _forced["device"] == "cpu":
        return None, None
    try:
        import torch
        if not _real_cuda_available():
            return None, None
        free_b, total_b = torch.cuda.mem_get_info()
        used_b = total_b - free_b
        return round(used_b / (1024 ** 2), 1), round(total_b / (1024 ** 2), 1)
    except Exception:
        return None, None


def _engine_state() -> dict:
    loaded = False
    loading = False
    try:
        import services.model_manager as mm
        status = mm.get_model_status()
        loaded = bool(status.get("loaded"))
        loading = bool(status.get("loading"))
    except Exception:
        pass
    _asr, b = _capture_backend()
    used_mb, total_mb = _vram_mb()
    return {
        "device": _effective_device(),
        "forced_device": _forced["device"] or "auto",
        "cuda_available": _real_cuda_available(),
        "tts_loaded": loaded,
        "tts_loading": loading,
        "asr_loaded": _is_loaded(b),
        "vram_used_mb": used_mb,
        "vram_total_mb": total_mb,
    }


@router.get("/sysmon/engine")
def engine_status():
    return _engine_state()


@router.post("/sysmon/engine/device")
async def engine_set_device(body: dict):
    target = _norm_device((body or {}).get("device"))
    if target is None:
        return JSONResponse(
            status_code=400,
            content={"error": "device must be 'cpu' or 'cuda'"},
        )
    if target == "cuda" and not _real_cuda_available():
        return JSONResponse(
            status_code=409,
            content={
                "error": "CUDA is not available in this container. Start omnivoice "
                "with the GPU visible (OMNIVOICE_CUDA_VISIBLE_DEVICES=0) to use GPU."
            },
        )

    try:
        import services.model_manager as mm
    except Exception as exc:
        return JSONResponse(status_code=500, content={"error": f"model_manager unavailable: {exc}"})

    logger.info("Switching engine device → %s (was %s)", target, _forced["device"] or "auto")

    # 1. Unload current TTS model under the model lock, and drop any cached
    #    GPU allocator blocks while the GPU is still visible.
    try:
        async with mm._model_lock:
            mm.model = None
        try:
            import torch
            if _real_cuda_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
    except Exception as exc:
        logger.warning("TTS unload during switch failed: %s", exc)

    # 2. Reset the capture ASR so it re-picks its device on next dictation.
    asr, b = _capture_backend()
    if asr is not None and b is not None:
        try:
            b.unload()
        except Exception:
            pass
        try:
            asr._capture_backend = None
        except Exception:
            pass

    # 3. Flip the lever + persist, then eagerly reload TTS on the new device.
    _forced["device"] = target
    _persist_device(target)
    try:
        await mm.preload_model()
    except Exception as exc:
        logger.warning("Eager reload after switch failed (will load lazily): %s", exc)

    state = _engine_state()
    state["switched_to"] = target
    return state


@router.post("/sysmon/engine/load")
async def engine_load():
    try:
        import services.model_manager as mm
        await mm.preload_model()
    except Exception as exc:
        return JSONResponse(status_code=500, content={"error": str(exc)})
    return _engine_state()


@router.post("/sysmon/engine/unload")
async def engine_unload():
    """Unload everything (TTS + capture ASR) and free VRAM. Device unchanged;
    models reload lazily (or via /sysmon/engine/load) on the current device."""
    try:
        import services.model_manager as mm
        async with mm._model_lock:
            mm.model = None
        mm.free_vram()
    except Exception as exc:
        logger.warning("TTS unload failed: %s", exc)
    asr, b = _capture_backend()
    if asr is not None and b is not None:
        try:
            b.unload()
        except Exception:
            pass
        try:
            asr._capture_backend = None
        except Exception:
            pass
    return _engine_state()
