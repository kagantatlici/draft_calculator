import os, tarfile, requests, subprocess, sys, pathlib

urls = {
  'det': 'https://paddleocr.bj.bcebos.com/PP-OCRv3/english/en_PP-OCRv3_det_infer.tar',
  'rec': 'https://paddleocr.bj.bcebos.com/PP-OCRv3/rec/en/en_PP-OCRv3_rec_infer.tar',
  'table': 'https://paddleocr.bj.bcebos.com/ppstructure/models/slanet/en_ppstructure_mobile_v2.0_SLANet_infer.tar',
}

outdir = pathlib.Path('dist/models')
outdir.mkdir(parents=True, exist_ok=True)

def download(url, dst_tar):
  with requests.get(url, stream=True) as r:
    r.raise_for_status()
    with open(dst_tar, 'wb') as f:
      for chunk in r.iter_content(1024*1024):
        if chunk:
          f.write(chunk)

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

for name, url in urls.items():
  tar_path = f'/tmp/{name}.tar'; dst_dir = f'/tmp/{name}'
  os.makedirs(dst_dir, exist_ok=True)
  print('downloading', name)
  download(url, tar_path)
  print('extract', name)
  extract(tar_path, dst_dir)
  pdmodel, pdiparams = find_files(dst_dir)
  if not pdmodel or not pdiparams:
    print('missing model files for', name, file=sys.stderr); sys.exit(2)
  onnx_out = outdir / f'{name}.onnx'
  print('convert to onnx', name)
  cmd = [
    'paddle2onnx',
    '--model_filename', pdmodel,
    '--params_filename', pdiparams,
    '--save_file', str(onnx_out),
    '--opset_version', '11',
    '--enable_onnx_checker', 'True'
  ]
  subprocess.check_call(cmd)
  print('ok', name, onnx_out)

