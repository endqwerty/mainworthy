#!/usr/bin/env python3
import json
import os
import pathlib
import statistics
import subprocess
import time

root = pathlib.Path.cwd()
seed = "/home/endqwerty/.cache/casebook-arena/stack/seed.db"
runs = {"cgo": [], "pure": []}
for round_number in range(5):
    for driver in ("cgo", "pure"):
        for suffix in ("", "-wal", "-shm"):
            (root / ("probe.db" + suffix)).unlink(missing_ok=True)
        subprocess.run(["cp", "--reflink=auto", seed, "probe.db"], check=True)
        path = f"driver-{driver}-{round_number+1}.json"
        begin = time.monotonic()
        subprocess.run([f"./casebook-{driver}", "driver-probe", "--db", str(root / "probe.db"), "--out", path], check=True)
        with open(path) as file:
            measured = json.load(file)
        measured["wallSeconds"] = time.monotonic() - begin
        for stats in measured["results"].values():
            assert stats["errors"] == 0 and stats["warmupErrors"] == 0, stats
        runs[driver].append(measured)
        print(f"driver={driver} round={round_number+1} W3.p95={measured['results']['W3']['p95']:.3f} W5.p50={measured['results']['W5']['p50']:.3f}", flush=True)

summary = {}
for driver, measured in runs.items():
    summary[driver] = {"artifactBytes": os.path.getsize(f"casebook-{driver}"), "static": "statically linked" in subprocess.check_output(["file", f"casebook-{driver}"], text=True), "runs": 5,
                       "residentMB": statistics.median(item["residentMB"] for item in measured), "workloads": {}}
    for name in measured[0]["results"]:
        values = [item["results"][name]["p50"] for item in measured]
        p95_values = [item["results"][name]["p95"] for item in measured]
        summary[driver]["workloads"][name] = {"p50Median": statistics.median(values), "p50Min": min(values), "p50Max": max(values),
                                               "p95Median": statistics.median(p95_values), "p95Min": min(p95_values), "p95Max": max(p95_values)}

# Search has the least budget headroom; choose the repeated HTTP p95 median.
winner = min(summary, key=lambda driver: summary[driver]["workloads"]["W3"]["p95Median"])
with open("selected-driver.txt", "w") as file:
    file.write(winner + "\n")
with open("driver-comparison.json", "w") as file:
    json.dump({"selection": winner, "criterion": "Repeated HTTP search p95 median and budget headroom; report ingest medians and overlapping run ranges separately", "summary": summary, "runs": runs}, file, indent=2)
for suffix in ("", "-wal", "-shm"):
    (root / ("probe.db" + suffix)).unlink(missing_ok=True)
