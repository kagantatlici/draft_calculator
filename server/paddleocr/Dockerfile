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
      cat >/tmp/build_onnx.py <<'PY' 
import os, tarfile, requests, subprocess, sys, time

url_sets = {
  'det': [
    'https://paddleocr.bj.bcebos.com/PP-OCRv3/english/en_PP-OCRv3_det_infer.tar',
    'https://paddleocr.bj.bcebos.com/PP-OCRv3/det/en/en_PP-OCRv3_det_infer.tar',
  ],
  'rec': [
    'https://paddleocr.bj.bcebos.com/PP-OCRv3/rec/en/en_PP-OCRv3_rec_infer.tar',
    'https://paddleocr.bj.bcebos.com/PP-OCRv3/rec/english/en_PP-OCRv3_rec_infer.tar',
    'https://paddleocr.bj.bcebos.com/PP-OCRv4/rec/en/en_PP-OCRv4_rec_infer.tar',
    'https://paddleocr.bj.bcebos.com/PP-OCRv2/rec/en/en_PP-OCRv2_rec_infer.tar',
  ],
  'table': [
    'https://paddleocr.bj.bcebos.com/ppstructure/models/slanet/en_ppstructure_mobile_v2.0_SLANet_infer.tar',
  ],
}

def download_with_fallback(name, urls, dst_tar):
  last = None
  for url in urls:
    try:
      print(f'downloading {name} from {url}')
      with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        with open(dst_tar, 'wb') as f:
          for chunk in r.iter_content(1024*1024):
            if chunk:
              f.write(chunk)
      return url
    except Exception as e:
      last = e
      print(f'failed {url}: {e}')
      time.sleep(1)
  print(f'no working URL for {name}', file=sys.stderr)
  raise last or Exception('no url')

def extract(tar_path, dst_dir):
  with tarfile.open(tar_path, 'r') as tar:
    def is_within_directory(directory, target):
      abs_directory = os.path.abspath(directory)
      abs_target = os.path.abspath(target)
      return os.path.commonprefix([abs_directory, abs_target]) == abs_directory
    for member in tar.getmembers():
      member_path = os.path.join(dst_dir, member.name)
      if not is_within_directory(dst_dir, member_path):
        raise Exception('Path traversal in tar file')
    tar.extractall(dst_dir)

def find_files(root):
  pdmodel = None; pdiparams = None
  for d,_,files in os.walk(root):
    for fn in files:
      if fn.endswith('.pdmodel'): pdmodel = os.path.join(d, fn)
      elif fn.endswith('.pdiparams'): pdiparams = os.path.join(d, fn)
  return pdmodel, pdiparams

for name, urls in url_sets.items():
  tar_path = f'/tmp/{name}.tar'; dst_dir = f'/tmp/{name}'
  os.makedirs(dst_dir, exist_ok=True)
  used = download_with_fallback(name, urls, tar_path)
  print('extract', name)
  extract(tar_path, dst_dir)
  pdmodel, pdiparams = find_files(dst_dir)
  if not pdmodel or not pdiparams:
    print('missing model files for', name, file=sys.stderr); sys.exit(2)
  onnx_out = f'/models/{name}.onnx'
  print('convert to onnx', name)
  cmd = [
    'paddle2onnx',
    '--model_dir', os.path.dirname(pdmodel),
    '--model_filename', os.path.basename(pdmodel),
    '--params_filename', os.path.basename(pdiparams),
    '--save_file', onnx_out,
    '--opset_version', '11',
    '--enable_onnx_checker', 'True'
  ]
  subprocess.check_call(cmd)
  print('ok', name, onnx_out)
PY
      && python /tmp/build_onnx.py; \
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
