from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from typing import Optional
import io
import json
import base64
import os

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
        from paddleocr import PPStructure
    except Exception as e:
        resp = JSONResponse(status_code=500, content={"error": f"Backend not ready: {e}"})
        return _ensure_headers(resp)

    # CPU safe flags
    os.environ.setdefault("FLAGS_use_mkldnn", "0")

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
        if max_side > 1800:
            scale = 1800.0 / max_side
            np_img = cv2.resize(np_img, (int(w*scale), int(h*scale)))
    except Exception:
        pass

    # Initialize engine (lang='en', CPU friendly)
    try:
        engine = app.state.table_engine
    except Exception:
        engine = None
    if engine is None:
        try:
            engine = PPStructure(show_log=False, lang='en', use_gpu=False)
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
    try:
        from paddleocr import PPStructure
        os.environ.setdefault("FLAGS_use_mkldnn", "0")
        app.state.table_engine = PPStructure(show_log=False, lang='en', use_gpu=False)
        # Trigger lazy ops with a tiny white image
        import numpy as np
        dummy = (255 * np.ones((64, 64, 3), dtype='uint8'))
        _ = app.state.table_engine(dummy)
    except Exception:
        # Defer to first request
        pass
