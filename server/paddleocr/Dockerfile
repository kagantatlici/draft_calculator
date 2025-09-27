FROM paddlepaddle/paddle:2.6.1

ENV PYTHONUNBUFFERED=1
WORKDIR /app

# System libs needed by OpenCV/Pillow
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 libgl1 && rm -rf /var/lib/apt/lists/*

# Python deps (Paddle preinstalled in base image)
RUN python -m pip install --no-cache-dir -U pip && \
    pip install --no-cache-dir fastapi==0.110.0 uvicorn[standard]==0.29.0 \
      python-multipart==0.0.9 pillow==10.4.0 numpy==1.26.4 \
      opencv-python-headless==4.10.0.84 paddleocr==2.7.0.3

COPY app.py /app/app.py

EXPOSE 5001
CMD sh -c "uvicorn app:app --host 0.0.0.0 --port ${PORT:-5001}"
