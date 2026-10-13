#!/usr/bin/env python3
import hashlib,json,os,subprocess,time,tomllib
from pathlib import Path
root=Path(__file__).resolve().parent
os.chdir(root)
before=(root/'target/release/mainworthy-rust-spike').exists()
started=time.perf_counter()
with open('build.log','w') as f:
    proc=subprocess.run(['cargo','build','--release','--locked','-j','6'],stdout=f,stderr=subprocess.STDOUT)
elapsed=time.perf_counter()-started
meta={'last_build_seconds':elapsed,'last_build_exit':proc.returncode,'binary_existed_before_build':before,
      'rustc':subprocess.check_output(['rustc','--version'],text=True).strip(),
      'cargo':subprocess.check_output(['cargo','--version'],text=True).strip(),
      'direct_dependencies':len(tomllib.loads((root/'Cargo.toml').read_text())['dependencies']),
      'versions':{p['name']:p['version'] for p in tomllib.loads((root/'Cargo.lock').read_text())['package']},
      'lines_written':sum(len(p.read_text().splitlines()) for p in list((root/'src').glob('*.rs'))+[root/'benchmark.py',root/'build.py',root/'run.sh']),
      'source_sha256':{str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in list((root/'src').glob('*.rs'))+[root/'benchmark.py',root/'build.py',root/'run.sh',root/'Cargo.toml',root/'Cargo.lock']}}
for f in ('clean-build-time.json','incremental-build-time.json','initial-build-time.json'):
    if (root/f).exists():meta[f.removesuffix('.json')]=json.loads((root/f).read_text())
(root/'build-metadata.json').write_text(json.dumps(meta,indent=2)+'\n')
print(f'release build {elapsed:.3f}s, exit={proc.returncode}',flush=True)
if proc.returncode:
    print((root/'build.log').read_text()[-16000:])
    raise SystemExit(proc.returncode)
