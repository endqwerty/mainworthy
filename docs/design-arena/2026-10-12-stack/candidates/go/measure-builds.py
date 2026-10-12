#!/usr/bin/env python3
import json
import os
import pathlib
import subprocess
import time

root = pathlib.Path.cwd()
metrics = {}
for driver in ("cgo", "pure"):
    cache = pathlib.Path(f"/home/endqwerty/.cache/casebook-arena/toolchains/go-clean-{driver}-{time.time_ns()}")
    cache.mkdir()
    env = dict(os.environ, CASEBOOK_BUILD_CACHE=str(cache))
    begin = time.monotonic()
    subprocess.run(["bash", "build.sh", driver], env=env, check=True)
    seconds = time.monotonic()-begin
    binary = "casebook-" + driver
    description = subprocess.check_output(["file", binary], text=True).strip()
    assert "statically linked" in description
    metrics[driver] = {"cleanBuildSeconds": seconds, "artifactBytes": os.path.getsize(binary), "artifactMiB": os.path.getsize(binary)/(1024*1024),
                       "linkage": description, "cache": str(cache), "definition": "Empty compiler cache; dependencies already downloaded; optimized stripped static binary"}
    print(f"{driver}: clean compile {seconds:.2f}s; static binary {metrics[driver]['artifactMiB']:.2f} MiB", flush=True)
with open("build-metrics.json", "w") as file:
    json.dump(metrics, file, indent=2)
