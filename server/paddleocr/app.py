from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from typing import Optional
import io
import json
import base64
import os
import asyncio
import multiprocessing as mp
import signal


def _inference_child(queue, arr):
    """Child process target: runs PaddleOCR PPStructure safely.
    Returns a small JSON-serializable payload via queue.
    """
    try:
        os.environ.setdefault("FLAGS_use_mkldnn", "0")
        os.environ.setdefault("FLAGS_enable_mkldnn", "0")
        _patch_paddle_predictor_ir()
        from paddleocr import PPStructure
        eng = PPStructure(
            show_log=False,
            lang='en',
            use_gpu=False,
            layout=False,
            use_onnx=True,
            # point to prebuilt ONNX models baked into the image
            det_model_dir='/models/det.onnx',
            rec_model_dir='/models/rec.onnx',
            table_model_dir='/models/table.onnx',
        )
        res = eng(arr)
        # Build response payload to avoid large IPC transfers
        cells = []
        csv_lines = []
        html = None
        bboxes = []
        confs = []
        for r in res:
            if isinstance(r, dict) and r.get('type') == 'table':
                if isinstance(r.get('res'), dict):
                    html = r['res'].get('html')
                if 'bbox' in r:
                    x1, y1, x2, y2 = r['bbox']
                    bboxes.append({
                        "x": int(x1),
                        "y": int(y1),
                        "w": int(x2 - x1),
                        "h": int(y2 - y1)
                    })
            if isinstance(r, dict) and r.get('res') and isinstance(r['res'], list):
                for it in r['res']:
                    if isinstance(it, dict) and 'text' in it:
                        line = it['text']
                        csv_lines.append(line)
                        try:
                            confs.append(float(it.get('confidence', 0)))
                        except Exception:
                            pass
                        cells.append([line])
        confidence = float(sum(confs) / len(confs)) if confs else 0.0
        payload = {
            "html": html,
            "cells": cells or None,
            "csv": "\n".join(csv_lines) if csv_lines else None,
            "bboxes": bboxes,
            "confidence": confidence,
        }
        queue.put((True, payload, None))
    except Exception as e:
        queue.put((False, None, str(e)))

# Be conservative on CPU-only hosts (e.g., Render free tier)
# Disable MKLDNN and keep threads low to avoid crashes on CPUs
# with limited instruction sets. Also patch Paddle IR passes below.
os.environ.setdefault("FLAGS_use_mkldnn", "0")
os.environ.setdefault("FLAGS_enable_mkldnn", "0")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")


def _patch_paddle_predictor_ir():
    """Monkey‑patch paddle.inference.create_predictor to turn off IR optim
    and drop the SelfAttention fuse pass which is the usual culprit for
    SIGILL on some CPUs/providers.
    """
    try:
        from paddle import inference as _paddle_infer  # type: ignore
    except Exception:
        return

    if getattr(_paddle_infer, "_patched_no_ir", False):
        return

    _orig_create = getattr(_paddle_infer, "create_predictor", None)
    if _orig_create is None:
        return

    def _wrapped_create(cfg):
        try:
            try:
                # Best effort: remove the problematic fuse pass and disable IR
                cfg.delete_pass("self_attention_fuse_pass")
                cfg.delete_pass("matmul_transpose_reshape_fuse_pass")
                cfg.delete_pass("fc_fuse_pass")
            except Exception:
                pass
            try:
                cfg.switch_ir_optim(False)
            except Exception:
                pass
        except Exception:
            # Never block predictor creation due to patching
            pass
        return _orig_create(cfg)

    _paddle_infer.create_predictor = _wrapped_create  # type: ignore
    _paddle_infer._patched_no_ir = True  # type: ignore

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)

@app.get("/health")
async def health():
    return {"ok": True}

def _ensure_headers(resp: JSONResponse):
    # Private Network Access hint for Chrome
    resp.headers['Access-Control-Allow-Private-Network'] = 'true'
    return resp

@app.post("/pp/table")
async def pp_table(file: UploadFile = File(...), roi: Optional[str] = Form(None)):
    data = await file.read()
    try:
        from PIL import Image
        import numpy as np
        import cv2
        # Do NOT import PPStructure in parent when isolation is enabled.
    except Exception as e:
        resp = JSONResponse(status_code=500, content={"error": f"Backend not ready: {e}"})
        return _ensure_headers(resp)

    # CPU/IR safe flags + patch
    os.environ.setdefault("FLAGS_use_mkldnn", "0")
    os.environ.setdefault("FLAGS_enable_mkldnn", "0")
    _patch_paddle_predictor_ir()

    # Load image
    img = Image.open(io.BytesIO(data)).convert('RGB')
    np_img = np.array(img)

    # ROI crop (normalized coords)
    if roi:
        try:
            r = json.loads(roi)
            h, w = np_img.shape[:2]
            x = max(0, min(w, int(float(r.get('x',0))*w)))
            y = max(0, min(h, int(float(r.get('y',0))*h)))
            ww = max(1, min(w-x, int(float(r.get('w',1))*w)))
            hh = max(1, min(h-y, int(float(r.get('h',1))*h)))
            np_img = np_img[y:y+hh, x:x+ww]
        except Exception:
            pass

    # Limit max side for memory
    try:
        import cv2
        h, w = np_img.shape[:2]
        max_side = max(h, w)
        if max_side > 1280:
            scale = 1280.0 / max_side
            np_img = cv2.resize(np_img, (int(w*scale), int(h*scale)))
    except Exception:
        pass

    # Run inference in an isolated subprocess to avoid hard crashes (SIGILL/OOM)
    isolate = os.getenv("ISOLATE_INFERENCE", "1").lower() in ("1", "true", "yes")
    if isolate:
        ctx = mp.get_context('spawn')
        q = ctx.Queue()
        p = ctx.Process(target=_inference_child, args=(q, np_img))
        p.start()
        p.join(timeout=float(os.getenv("INFER_TIMEOUT", "55")))
        if p.is_alive():
            p.terminate()
            p.join()
            resp = JSONResponse(status_code=504, content={"error": "Inference timeout"})
            return _ensure_headers(resp)
        if p.exitcode is None:
            ok, payload, err = q.get() if not q.empty() else (False, None, "no result")
            if not ok:
                resp = JSONResponse(status_code=502, content={"error": f"Inference failed: {err}"})
                return _ensure_headers(resp)
            return _ensure_headers(JSONResponse(content=payload))
        # Crash path: negative exit code indicates signal
        if p.exitcode != 0:
            sig = -p.exitcode if p.exitcode < 0 else 0
            msg = f"backend crashed (signal={sig})" if sig else f"backend exited with code {p.exitcode}"
            resp = JSONResponse(status_code=502, content={"error": msg})
            return _ensure_headers(resp)
        # Normal exit: read queue
        ok, payload, err = q.get() if not q.empty() else (False, None, "no result")
        if not ok:
            resp = JSONResponse(status_code=502, content={"error": f"Inference failed: {err}"})
            return _ensure_headers(resp)
        return _ensure_headers(JSONResponse(content=payload))
    else:
        # Initialize engine in parent process only when isolation is disabled
        try:
            engine = app.state.table_engine
        except Exception:
            engine = None
        if engine is None:
            try:
                from paddleocr import PPStructure
                engine = PPStructure(
                    show_log=False,
                    lang='en',
                    use_gpu=False,
                    layout=False,
                    use_onnx=True,
                    det_model_dir='/models/det.onnx',
                    rec_model_dir='/models/rec.onnx',
                    table_model_dir='/models/table.onnx',
                )
                app.state.table_engine = engine
            except Exception as e:
                resp = JSONResponse(status_code=500, content={"error": f"Engine init failed: {e}"})
                return _ensure_headers(resp)
        try:
            result = engine(np_img)
        except Exception as e:
            resp = JSONResponse(status_code=502, content={"error": f"Inference failed: {e}"})
            return _ensure_headers(resp)

    # Build simple CSV and cells
    cells = []
    csv_lines = []
    html = None
    bboxes = []
    confs = []
    for r in result:
        if r.get('type') == 'table':
            html = r.get('res', {}).get('html') if isinstance(r.get('res'), dict) else None
            # Basic CSV from structure if available
            if isinstance(r.get('res'), dict) and 'cell' in r['res']:
                # Fallback simple: use text list
                pass
            # collect box
            if 'bbox' in r:
                x1,y1,x2,y2 = r['bbox']
                bboxes.append({"x": int(x1), "y": int(y1), "w": int(x2-x1), "h": int(y2-y1)})
        if r.get('res') and isinstance(r['res'], list):
            for it in r['res']:
                if isinstance(it, dict) and 'text' in it:
                    line = it['text']
                    csv_lines.append(line)
                    confs.append(float(it.get('confidence', 0)))
                    cells.append([line])

    confidence = float(sum(confs)/len(confs)) if confs else 0.0
    payload = {"html": html, "cells": cells or None, "csv": "\n".join(csv_lines) if csv_lines else None, "bboxes": bboxes, "confidence": confidence}
    resp = JSONResponse(content=payload)
    return _ensure_headers(resp)

@app.on_event("startup")
async def warmup():
    # Preload models to avoid first-request latency & reduce 502
    # Optionally perform warmup in background only when enabled.
    enable = os.getenv("ENABLE_WARMUP", "0").lower() in ("1", "true", "yes")
    if not enable:
        return

    async def _bg():
        try:
            from paddleocr import PPStructure
            os.environ.setdefault("FLAGS_use_mkldnn", "0")
            os.environ.setdefault("FLAGS_enable_mkldnn", "0")
            _patch_paddle_predictor_ir()
            # layout=False to reduce model downloads during warmup
            app.state.table_engine = PPStructure(
                show_log=False,
                lang='en',
                use_gpu=False,
                layout=False,
                rec_algorithm='CRNN',
                ocr_version='PP-OCRv2',
            )
            # Trigger lazy ops with a tiny white image
            import numpy as np
            dummy = (255 * np.ones((64, 64, 3), dtype='uint8'))
            _ = app.state.table_engine(dummy)
        except Exception:
            # Ignore warmup failures; serve requests lazily
            pass

    asyncio.create_task(_bg())
