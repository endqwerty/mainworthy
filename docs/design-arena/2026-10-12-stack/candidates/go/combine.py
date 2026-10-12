#!/usr/bin/env python3
import json
import os
import sys
from datetime import datetime, timezone

def read(path, fallback=None):
    try:
        with open(path) as file:
            return json.load(file)
    except FileNotFoundError:
        return fallback

embedded = read("embedded.json")
server = read("server.json")
proof = read("registry-proof.json")
extras = {"driver": embedded["driver"], "coldStart": {"embedded": embedded["coldStart"], "server": server["coldStart"]},
          "coldStartSamples": {"embedded": embedded["coldStartSamples"], "server": server["coldStartSamples"]},
          "residentMB": {"embedded": embedded["residentMB"], "server": server["residentMB"]},
          "registry": {key: proof[key] for key in ("protocolVersion", "toolsListResultBytes", "toolsListWireBytes", "checks")},
          "runSeconds": int(sys.argv[1]), "driverComparison": read("driver-comparison.json", {}), "build": read("build-metrics.json", {}),
          "diagnostics": {"embedded": read("diagnostics-embedded-sqlite3.json", {}), "server": read("diagnostics-server-sqlite3.json", {})},
          "directDependencies": 4, "declaredDependenciesIncludingAlternativeDriver": 5,
          "sourceLines": sum(len(open(path).readlines()) for path in os.listdir(".") if path.endswith((".go", ".py", ".sh"))),
          "measurement": "HTTP includes client JSON encoding, loopback keep-alive, server decoding, operation, response encoding and client decoding. In-process is the shared typed operation, with no HTTP/schema validation/JSON wire encoding. Cold process starts use an already-cached data file. All performance is provisional under concurrent arena load.",
          "durability": {"embedded": "WAL, synchronous=NORMAL", "server": "synchronous_commit=on"},
          "verification": read("verification.json", {"status": "pending"})}
extras["sourceRevision"] = read("source-manifest.json", {}).get("revision", "not recorded")
extras["generatedAtUTC"] = datetime.now(timezone.utc).isoformat()
extras["units"] = {"latency": "milliseconds", "residentMB": "MiB", "artifactMiB": "MiB"}
results = {"stack": "Go", "mode": {"embedded": embedded["results"], "server": server["results"]}, "extras": extras}
with open("results.json", "w") as file:
    json.dump(results, file, indent=2)
errors = 0
expected_iterations = {"W1": 2000, "W2": 1000, "W3": 500, "W4": 1000, "W5": 20, "W5a": 20, "W6": 2000, "W7": 2000, "W8": 1000}
budget_ms = {"W1": 20, "W2": 50, "W3": 100, "W4": 50, "W5": 2000, "W6": 20, "W7": 20, "W8": 50, "W9": 50}
misses = []
for mode, workloads in results["mode"].items():
    assert set(workloads) == set(expected_iterations) | {"W9"}
    for name, measured in workloads.items():
        errors += measured.get("errors", 0) + measured.get("warmupErrors", 0)
        if name in expected_iterations:
            assert measured["iterations"] == expected_iterations[name] and measured["warmup"] == 100
        if name in budget_ms:
            metric = "max" if name == "W5" else "p95"
            if measured[metric] >= budget_ms[name]: misses.append(f"{mode}.{name}.{metric}")
        if name == "W9":
            errors += measured["ingest"]["errors"] + measured["save"]["errors"]
            assert measured["seconds"] >= 20 and measured["ingest"]["iterations"] > 0 and measured["save"]["iterations"] > 0
            if measured["ingest"]["max"] >= 2000: misses.append(f"{mode}.W9.ingest.max")
results["extras"]["budgetMisses"] = misses
with open("results.json", "w") as file:
    json.dump(results, file, indent=2)
assert errors == 0, f"{errors} workload errors"
assert extras["runSeconds"] < 600, "run exceeded ten minutes"
print(f"PASS all workloads in both modes; zero errors; run.sh {extras['runSeconds']} seconds")
