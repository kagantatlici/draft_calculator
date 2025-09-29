FROM paddlepaddle/paddle:2.6.1

ENV PYTHONUNBUFFERED=1
WORKDIR /app

# System libs needed by OpenCV/Pillow
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 libgl1 curl && rm -rf /var/lib/apt/lists/*

# Python deps (Paddle preinstalled in base image)
RUN python -m pip install --no-cache-dir -U pip && \
    pip install --no-cache-dir fastapi==0.110.0 uvicorn[standard]==0.29.0 \
      python-multipart==0.0.9 pillow==10.4.0 numpy==1.26.4 \
      opencv-python-headless==4.10.0.84 paddleocr==2.7.0.3 \
      onnxruntime==1.18.1 requests==2.31.0 tqdm==4.66.4 \
      paddle2onnx==1.0.9 six onnx==1.16.0

# Options for ONNX models source:
# - auto (default): Download Paddle models and convert to ONNX during build
# - releases: Fetch prebuilt ONNX from GitHub Releases
# - local: Copy ONNX files committed under server/paddleocr/models
ARG MODELS_SOURCE=auto
ENV MODELS_SOURCE=${MODELS_SOURCE}
ENV GITHUB_REPO=kagantatlici/draft_calculator MODELS_TAG=models-v1

# Copy app and optional local models directory
COPY server/paddleocr/app.py /app/app.py
COPY server/paddleocr/models/ /app/models/
COPY scripts/build_onnx_models.py /tmp/build_onnx.py

RUN set -eux; \
    mkdir -p /models; \
    if [ "${MODELS_SOURCE}" = "local" ]; then \
      echo "Using local ONNX models from repo"; \
      cp -v /app/models/*.onnx /models/; \
    elif [ "${MODELS_SOURCE}" = "releases" ]; then \
      echo "Fetching ONNX models from GitHub Releases"; \
      for f in det.onnx rec.onnx table.onnx; do \
        curl -fSL -o /models/$f https://github.com/${GITHUB_REPO}/releases/download/${MODELS_TAG}/$f; \
      done; \
    else \
      echo "Building ONNX models during image build"; \
      python /tmp/build_onnx.py; \
    fi

# Render builds with repo root as context; copy using repo-relative path.
COPY server/paddleocr/app.py /app/app.py

EXPOSE 5001
# Conservative CPU flags for broader CPU compatibility
ENV FLAGS_use_mkldnn=0 \
    FLAGS_enable_mkldnn=0 \
    OMP_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    ENABLE_WARMUP=0

CMD sh -c "uvicorn app:app --host 0.0.0.0 --port ${PORT:-5001} --workers 1"
