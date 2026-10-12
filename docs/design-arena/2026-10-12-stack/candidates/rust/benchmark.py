#!/usr/bin/env python3
"""Real HTTP benchmark for the Rust Casebook spike; Python standard library only."""
import concurrent.futures
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import random
import selectors
import socket
import shutil
import sqlite3
import subprocess
import threading
import time
import traceback
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent
SHARED = ROOT.parent
SCRATCH = ROOT / "tmp" / "driver"
BINARY = ROOT / "target" / "release" / "casebook-rust-spike"
PORT = int(os.environ.get("RUST_BENCH_PORT", "18483"))
PG = "host=127.0.0.1 port=54329 user=postgres dbname=cb_rust"
WARMUP = 100
COUNTS = {"W1": 2000, "W2": 1000, "W3": 500, "W4": 1000,
          "W5": 20, "W5a": 20, "W6": 2000, "W7": 2000, "W8": 1000}
CHECKS = {
    "W1": "Requested case ref and structured head body/title returned",
    "W2": "50 ordered folder rows after cursor with test glyphs and queue count; sampled glyphs match seed",
    "W3": "At most 50 relevance-ranked hits; all AND terms and optional 24-folder scope match",
    "W4": "One command/version/decided question/decision, head and full-text updated; 20 replays write nothing",
    "W5": "10,000 results, 100 new tests, 200 failures, 20 signatures (10 new), basis and tally audited; replay writes nothing",
    "W5a": "10,000 parsed testcases, 200 failures with 400-byte messages",
    "W6": "At most 20 results for requested test, descending sequence and ordinal",
    "W7": "Requested commit run returned with parsed tally",
    "W8": "50 open ordered questions, parsed evidence and consistent open count",
}


def require(ok, message):
    if not ok:
        raise AssertionError(message)


def distribution(values):
    ordered = sorted(values)
    if not ordered:
        return {"p50": None, "p95": None, "p99": None, "max": None, "samples": 0}
    return {**{f"p{p}": round(ordered[max(0, math.ceil(len(ordered) * p / 100) - 1)], 4)
               for p in (50, 95, 99)}, "max": round(ordered[-1], 4), "samples": len(ordered)}


class Client:
    def __init__(self):
        self.connection = http.client.HTTPConnection("127.0.0.1", PORT, timeout=120)

    def close(self):
        self.connection.close()

    def request(self, path, body=None, raw=None, method="POST"):
        payload = raw if raw is not None else json.dumps(body or {}, separators=(",", ":")).encode()
        headers = {"Content-Type": "application/xml" if raw is not None else "application/json"}
        started = time.perf_counter()
        try:
            self.connection.request(method, path, body=None if method == "GET" else payload, headers=headers)
            response = self.connection.getresponse()
            wire = response.read()
            result = json.loads(wire)
            elapsed = (time.perf_counter() - started) * 1000
            require(response.status == 200, f"{path}: HTTP {response.status}: {str(result)[:300]}")
            header = response.getheader("X-Store-Ms")
            store = float(header) if header is not None else None
            return result, elapsed, store
        except Exception:
            self.connection.close()
            raise


class Driver:
    def __init__(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        self.seed = sqlite3.connect(f"file:{SHARED / 'seed.db'}?mode=ro", uri=True)
        self.seed.row_factory = sqlite3.Row
        self.keys = [r[0] for r in self.seed.execute("SELECT key FROM test WHERE id<=9900 ORDER BY id")]
        self.samples = [r[0] for r in self.seed.execute("SELECT sample FROM signature ORDER BY id LIMIT 10")]
        self.commits = [r[0] for r in self.seed.execute("SELECT commit_sha FROM run ORDER BY id")]
        self.seed_tallies = {r[0]: json.loads(r[1]) for r in self.seed.execute("SELECT commit_sha,tally FROM run")}
        self.queries = (SHARED / "queries.txt").read_text().splitlines()
        self.rng = random.Random(10112026)
        self.results = {"stack": "rust", "mode": {}, "extras": {
            "measurement": "Real loopback HTTP, persistent connections, Python stdlib driver; payload construction excluded, response decode included",
            "warmup_iterations": WARMUP, "concurrent_candidates": "Run externally serially for final comparison",
        }}
        self.process = None
        self.log = None
        self.mode = None
        self.save_counter = 0
        self.report_counter = 0
        self.search_counter = 0
        self.latest_report = None
        self.latest_saves = []
        self.generation_cpu = 0
        self.heads = {int(r[0]): int(r[1]) for r in self.seed.execute("SELECT ref_no,head_no FROM kase")}
        self.fixture = self.make_fixture()

    def checkpoint(self):
        target = ROOT / "results.json"
        temporary = SCRATCH / "results.partial.json"
        temporary.write_text(json.dumps(self.results, indent=2) + "\n")
        temporary.replace(target)

    def reset(self, mode):
        if mode == "embedded":
            for suffix in ("", "-wal", "-shm"):
                p = ROOT / ("work.db" + suffix)
                if p.exists():
                    p.unlink()
            shutil.copyfile(SHARED / "seed.db", ROOT / "work.db")
        else:
            args = ["psql", "-X", "-h", "127.0.0.1", "-p", "54329", "-U", "postgres", "-d", "postgres",
                    "-v", "ON_ERROR_STOP=1", "-c", "DROP DATABASE IF EXISTS cb_rust",
                    "-c", "CREATE DATABASE cb_rust TEMPLATE cb_seed"]
            done = subprocess.run(args, capture_output=True, text=True, timeout=90)
            require(done.returncode == 0, f"reset PostgreSQL: {done.stderr[:500]}")

    def server_args(self, mode):
        return [str(BINARY), "serve", mode, str(ROOT / "work.db") if mode == "embedded" else PG, str(PORT)]

    def start(self, mode):
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
            probe.bind(("127.0.0.1",PORT))
        self.log = (SCRATCH / f"{mode}-server.log").open("ab")
        started = time.perf_counter()
        self.process = subprocess.Popen(self.server_args(mode), stdout=self.log, stderr=self.log, cwd=ROOT)
        deadline = started + 40
        while time.perf_counter() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError(f"server exited {self.process.returncode}; see {mode}-server.log")
            client = Client()
            try:
                value, _, _ = client.request("/health", method="GET")
                require(value.get("ok") is True, "health did not return ok:true")
                require(self.process.poll() is None,"new server exited during health check")
                return (time.perf_counter() - started) * 1000
            except (OSError, http.client.HTTPException):
                time.sleep(.005)
            finally:
                client.close()
        raise TimeoutError("server did not start within 40 seconds")

    def stop(self):
        if self.process:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
            self.process = None
        if self.log:
            self.log.close()
            self.log = None

    def cpu(self):
        if not self.process:
            return None
        raw = Path(f"/proc/{self.process.pid}/stat").read_text()
        fields = raw[raw.rindex(")") + 2:].split()
        return (int(fields[11]) + int(fields[12])) / os.sysconf("SC_CLK_TCK")

    def rss(self):
        lines = Path(f"/proc/{self.process.pid}/status").read_text().splitlines()
        return int(next(line for line in lines if line.startswith("VmRSS:")).split()[1]) / 1024

    def make_fixture(self):
        xml = ['<?xml version="1.0" encoding="UTF-8"?><testsuites><testsuite name="casebook" tests="10000" failures="200">']
        for i in range(10000):
            xml.append(f'<testcase classname="bench.suite" name="test-{i}" time="0.025">')
            if i < 200:
                message = f"failure group {i % 20}: expected & actual < value > "
                message += "x" * (400 - len(message))
                xml.append('<failure type="AssertionError" message="failure">' + escape(message) + '</failure>')
            xml.append('</testcase>')
        xml.append('</testsuite></testsuites>')
        payload = ''.join(xml).encode()
        # Keep generated fixture in the driver's owned scratch directory.
        (SCRATCH / "junit.xml").write_bytes(payload)
        self.results["extras"]["junit_fixture_bytes"] = len(payload)
        return payload

    def save_payload(self, rng=None):
        rng = rng or self.rng
        self.save_counter += 1
        ref = rng.randint(40001, 100000)
        marker = f"rust{self.mode}save{self.save_counter}"
        body = {"title": f"Casebook {marker} immutable version", "pre": "Signed in with a project that has existing cases.",
                "steps": [{"id": "s1", "action": "Open the versioned case and review its current steps. " + "detail " * 13,
                           "expected": "The saved head and title agree with the canonical document."},
                          {"id": "s2", "action": "Seal this fresh document with the supplied client command id. " + "content " * 10,
                           "expected": None}], "methods": [{"m": "human"}], "intent": {"automate": "none"}, "fields": {}}
        return {"cmd": marker, "ref_no": ref, "base_no": self.heads[ref], "body": body}

    def report_payload(self):
        self.report_counter += 1
        marker = f"rust-{self.mode}-batch-{self.report_counter}"
        # Letters survive normalisation that removes volatile numbers/addresses.
        token = hashlib.sha256(marker.encode()).hexdigest().translate(str.maketrans("0123456789", "ghijklmnop"))
        messages = self.samples + [f"Casebook fresh invariant {token} kind {chr(97+i)} violated" for i in range(10)]
        started = time.process_time()
        rows = [{"key": key, "outcome": "fail" if i < 200 else "pass", "durationMs": 25,
                 **({"message": messages[i % 20]} if i < 200 else {})} for i, key in enumerate(self.keys)]
        rows.extend({"key": f"{marker}::fresh::{i}", "outcome": "pass", "durationMs": 25} for i in range(100))
        self.generation_cpu += time.process_time() - started
        return {"batch_key": marker, "commit_sha": hashlib.sha1(marker.encode()).hexdigest(), "results": rows}

    def operation(self, client, name, rng=None):
        rng = rng or self.rng
        if name == "W1":
            ref = rng.randint(1, 100000)
            out, elapsed, store = client.request("/op/get", {"ref_no": ref})
            case, body = out["case"], out["body"]
            require(case["ref_no"] == ref and case["project"] == 1, "W1 wrong case")
            require(isinstance(body, dict) and isinstance(body["steps"], list) and body["title"] == case["title"], "W1 wrong head body")
        elif name == "W2":
            folder, cursor = rng.randint(21, 500), rng.randint(0, 157000)
            out, elapsed, store = client.request("/bench/w2", {"folder": folder, "cursor": cursor})
            rows = out["items"]
            require(len(rows) == 50, f"W2 page length {len(rows)}")
            ranks = [row["rank"] for row in rows]
            require(ranks == sorted(ranks) and len(set(ranks)) == len(ranks) and all(rank > cursor for rank in ranks), "W2 rank order/cursor")
            require(all(row["folder"] == folder and row["project"] == 1 and row["test_count"] == len(row["last_outcomes"]) for row in rows), "W2 folder/glyphs")
            require(out["open_questions"] >= 50000, "W2 queue count")
        elif name == "W3":
            query = self.queries[self.search_counter % len(self.queries)]
            area = rng.randint(1, 20) if self.search_counter % 5 == 0 else None
            self.search_counter += 1
            arg = {"query": query, **({"area": area} if area else {})}
            out, elapsed, store = client.request("/bench/w3", arg)
            rows = out["items"]
            require(len(rows) <= 50, "W3 more than 50 hits")
            require(all(all(term.lower() in row["text"].lower() for term in query.split()) for row in rows), "W3 AND terms missing")
            if area:
                lower = 21 + (area - 1) * 24
                require(all(lower <= row["folder"] <= lower + 23 for row in rows), "W3 area scope")
            scores = [row["score"] for row in rows]
            require(scores == sorted(scores) or scores == sorted(scores, reverse=True), "W3 relevance order")
        elif name == "W4":
            payload = self.save_payload(rng)
            out, elapsed, store = client.request("/op/propose", payload)
            require(out["case_id"] == payload["ref_no"] and out["no"] == payload["base_no"] + 1, "W4 case/version receipt")
            require(out["seq"] > 219966 and bool(out["hash"]) and out["question"] and out["decision"], "W4 incomplete receipt")
            self.heads[payload["ref_no"]] = out["no"]
            self.latest_saves.append((payload, out))
            self.latest_saves = self.latest_saves[-20:]
        elif name == "W5":
            payload = self.report_payload()
            out, elapsed, store = client.request("/op/report", payload)
            require(out["results"] == 10000 and out["new_tests"] == 100 and out["new_signatures"] == 10, "W5 insert counts")
            require(out["batch_id"] and out["seq"] > 219966, "W5 missing receipt")
            self.latest_report = (payload, out)
        elif name == "W5a":
            out, elapsed, store = client.request("/parse", raw=self.fixture)
            require(out["count"] == 10000 and out["failures"] == 200 and out["parse_ms"] >= 0, "W5a parser counts")
            if "message_bytes" in out:
                require(out["message_bytes"] == 80000, "W5a decoded failure messages differ")
            if "keys_nonempty" in out:
                require(out["keys_nonempty"] is True, "W5a parser produced empty test keys")
            # Parse time is the operation's in-process measurement.
            store = float(out["parse_ms"])
        elif name == "W6":
            test = rng.randint(1, 20000)
            out, elapsed, store = client.request("/bench/w6", {"test": test})
            rows = out["items"]
            require(len(rows) == 20 and all(row["test"] == test and row["project"] == 1 for row in rows), "W6 result count/test")
            order = [(row["seq"], row["ord"]) for row in rows]
            require(order == sorted(order, reverse=True), "W6 result order")
        elif name == "W7":
            commit = rng.choice(self.commits)
            out, elapsed, store = client.request("/bench/w7", {"commit_sha": commit})
            require(out["run"]["commit_sha"] == commit and out["run"]["project"] == 1 and isinstance(out["tally"], dict), "W7 commit/tally")
            require(out["tally"] == self.seed_tallies[commit], "W7 tally differs from seed")
        elif name == "W8":
            out, elapsed, store = client.request("/bench/w8")
            rows = out["items"]
            require(len(rows) == 50 and out["open_questions"] >= 50000, "W8 page/count")
            require(all(row["state"] == "open" and row["project"] == 1 and isinstance(row["evidence"], (dict, list)) for row in rows), "W8 state/evidence")
            ranks = [(row["owner"], row["rank"]) for row in rows]
            require(ranks == sorted(ranks), "W8 queue order")
        else:
            raise ValueError(name)
        require(store is not None and store >= 0, f"{name} missing X-Store-Ms")
        return elapsed, store

    def error(self, entry, exc, warmup=False):
        key = "warmup_errors" if warmup else "errors"
        entry[key] = entry.get(key, 0) + 1
        errors = entry.setdefault("error_examples", [])
        if len(errors) < 3:
            errors.append(f"{type(exc).__name__}: {str(exc)[:500]}")

    def workload(self, client, name):
        entry = {"errors": 0, "warmup_errors": 0, "check": CHECKS[name], "check_passed": False,
                 "warmup_iterations": WARMUP, "iterations": COUNTS[name]}
        self.results["mode"][self.mode][name] = entry
        values, store_values = [], []
        durable_before = self.durable_snapshot() if name in ("W4", "W5") else None
        cpu_before = self.cpu()
        wall_before = time.perf_counter()
        for i in range(WARMUP + COUNTS[name]):
            try:
                elapsed, store = self.operation(client, name)
                if i >= WARMUP:
                    values.append(elapsed)
                    store_values.append(store)
            except Exception as exc:
                self.error(entry, exc, warmup=i < WARMUP)
        entry.update(distribution(values))
        entry["store_ms"] = distribution(store_values)
        entry["server_cpu_seconds"] = round(self.cpu() - cpu_before, 4)
        entry["wall_seconds"] = round(time.perf_counter() - wall_before, 4)
        try:
            self.audit(client, name)
            if durable_before:
                durable_after = self.durable_snapshot()
                delta = {key: durable_after[key] - durable_before[key] for key in durable_before}
                entry["durable_write_delta"] = delta
                iterations = WARMUP + COUNTS[name]
                expected = ({"seq": iterations, "command_count": iterations, "version_count": iterations,
                             "question_count": iterations, "decision_count": iterations}
                            if name == "W4" else
                            {"seq": iterations, "result_count": iterations * 10000, "test_count": iterations * 100,
                             "signature_count": iterations * 10, "batch_count": iterations, "target_count": iterations})
                for key, value in expected.items():
                    require(delta[key] == value, f"{name} durable {key} delta {delta[key]} != {value}")
        except Exception as exc:
            self.error(entry, exc)
        entry["check_passed"] = entry["errors"] == 0 and entry["warmup_errors"] == 0
        self.checkpoint()
        print(f"{self.mode} {name}: p95={entry['p95']} ms errors={entry['errors']} warmup_errors={entry['warmup_errors']}", flush=True)

    def snapshot(self, client):
        return client.request("/bench/audit", {"kind": "snapshot"})[0]

    def sql(self, query):
        """Independent read-only SQL oracle; excluded from workload timings."""
        if self.mode == "embedded":
            con = sqlite3.connect(f"file:{ROOT / 'work.db'}?mode=ro", uri=True)
            con.row_factory = sqlite3.Row
            try:
                return [dict(row) for row in con.execute(query)]
            finally:
                con.close()
        wrapped = "SELECT COALESCE(json_agg(row_to_json(proof)), '[]'::json) FROM (" + query + ") proof"
        command = ["psql", "-X", "-t", "-A", "-h", "127.0.0.1", "-p", "54329", "-U", "postgres", "-d", "cb_rust", "-v", "ON_ERROR_STOP=1", "-c", wrapped]
        done = subprocess.run(command, capture_output=True, text=True, timeout=30)
        require(done.returncode == 0, f"SQL oracle: {done.stderr[:300]}")
        return json.loads(done.stdout)

    def durable_snapshot(self):
        tables = ("command", "version", "question", "decision", "result", "test", "signature", "batch", "target")
        return self.sql("SELECT (SELECT seq FROM project WHERE id=1) AS seq," + ",".join(f"(SELECT count(*) FROM {table}) AS {table}_count" for table in tables))[0]

    def audit(self, client, name):
        if name == "W2":
            folder, cursor = 21, 0
            out = client.request("/bench/w2", {"folder": folder, "cursor": cursor})[0]
            expected = list(self.seed.execute("SELECT * FROM kase WHERE project=1 AND folder=? AND rank>? ORDER BY rank LIMIT 50", (folder, cursor)))
            require([r["id"] for r in out["items"]] == [r["id"] for r in expected], "W2 SQL page differs from seed")
            for row in out["items"]:
                tests = list(self.seed.execute("SELECT id FROM test WHERE project=1 AND case_id=? ORDER BY id", (row["id"],)))
                outcomes = [self.seed.execute("SELECT outcome FROM result WHERE project=1 AND test=? ORDER BY seq DESC,ord DESC LIMIT 1", (t[0],)).fetchone()[0] for t in tests]
                require(row["test_count"] == len(tests) and sorted(row["last_outcomes"]) == sorted(outcomes), "W2 latest result glyph disagrees with seed")
            require(out["open_questions"] == self.sql("SELECT count(*) AS n FROM question WHERE project=1 AND state='open'")[0]["n"], "W2 open count differs from durable rows")
        elif name == "W4":
            require(len(self.latest_saves) == 20, "W4 fewer than 20 successful commands")
            payload, receipt = self.latest_saves[-1]
            audit = client.request("/bench/audit", {"kind": "save", "cmd": payload["cmd"]})[0]
            for table in ("command", "version", "question", "decision", "search"):
                require(len(audit[table]) == 1, f"W4 audit {table} != 1")
            version = audit["version"][0]
            body = version["body"]
            if isinstance(body, str):
                body = json.loads(body)
            require(body == payload["body"] and version["no"] == receipt["no"] and version["hash"] == receipt["hash"], "W4 stored version mismatch")
            require(audit["question"][0]["state"] == "decided", "W4 question not decided")
            require(payload["body"]["title"] in audit["search"][0]["text"], "W4 FTS document not replaced")
            before = self.snapshot(client)
            durable_before = self.durable_snapshot()
            for replay, expected in self.latest_saves:
                actual = client.request("/op/propose", replay)[0]
                require(actual == expected, "W4 replay receipt changed")
            require(before == self.snapshot(client), "W4 replay wrote rows/sequence")
            require(durable_before == self.durable_snapshot(), "W4 replay changed independently read durable rows/sequence")
            head = client.request("/op/get", {"ref_no": payload["ref_no"]})[0]
            require(head["case"]["head_no"] == receipt["no"] and head["case"]["head_hash"] == receipt["hash"] and head["body"] == payload["body"], "W4 head not updated")
        elif name == "W5":
            require(self.latest_report is not None, "W5 no successful batch")
            payload, receipt = self.latest_report
            audit = client.request("/bench/audit", {"kind": "report", "batch_key": payload["batch_key"]})[0]
            expected = {"batch_id": receipt["batch_id"], "results": 10000, "failures": 200,
                        "signatures": 20, "assumed": 9900, "unresolved": 100, "bad_basis": 0,
                        "open_duplicates": 0, "run_tally": {"pass": 9800, "fail": 200}}
            for key, value in expected.items():
                require(audit[key] == value, f"W5 audit {key}: {audit[key]} != {value}")
            before = self.snapshot(client)
            durable_before = self.durable_snapshot()
            replay = client.request("/op/report", payload)[0]
            require(replay == receipt or (replay.get("batch_id") == receipt["batch_id"] and replay.get("seq") == receipt["seq"] and replay.get("results") == 0 and replay.get("replay") is True), "W5 replay receipt changed")
            require(before == self.snapshot(client), "W5 replay wrote rows/sequence")
            require(durable_before == self.durable_snapshot(), "W5 replay changed independently read durable rows/sequence")
            identifier = int(receipt["batch_id"])
            rows = self.sql(f"SELECT count(*) AS results,sum(CASE WHEN outcome='fail' THEN 1 ELSE 0 END) AS failures,count(DISTINCT signature) AS signatures,sum(CASE WHEN basis='assumed' THEN 1 ELSE 0 END) AS assumed,sum(CASE WHEN basis='unresolved' THEN 1 ELSE 0 END) AS unresolved FROM result WHERE batch={identifier}")[0]
            require(rows == {"results": 10000, "failures": 200, "signatures": 20, "assumed": 9900, "unresolved": 100}, f"W5 durable rows differ: {rows}")
            bad = self.sql(f"SELECT count(*) AS n FROM result r JOIN test t ON t.id=r.test LEFT JOIN kase k ON k.id=t.case_id WHERE r.batch={identifier} AND ((t.case_id IS NOT NULL AND (r.basis<>'assumed' OR r.basis_case<>t.case_id OR r.basis_version<>k.head_no OR r.basis_case IS NULL OR r.basis_version IS NULL)) OR (t.case_id IS NULL AND (r.basis<>'unresolved' OR r.basis_case IS NOT NULL OR r.basis_version IS NOT NULL)))")[0]["n"]
            require(bad == 0, f"W5 durable basis/head mismatch: {bad}")
        elif name == "W6":
            out = client.request("/bench/w6", {"test": 17001})[0]
            expected = self.sql("SELECT id,seq,ord,outcome FROM result WHERE project=1 AND test=17001 ORDER BY seq DESC,ord DESC LIMIT 20")
            actual = [{key: row[key] for key in ("id", "seq", "ord", "outcome")} for row in out["items"]]
            require(actual == expected, "W6 latest results differ from durable rows")
        elif name == "W8":
            out = client.request("/bench/w8")[0]
            expected = self.sql("SELECT id FROM question WHERE project=1 AND state='open' ORDER BY owner,rank LIMIT 50")
            require([row["id"] for row in out["items"]] == [row["id"] for row in expected], "W8 ordered page differs from durable rows")
            require(out["open_questions"] == self.sql("SELECT count(*) AS n FROM question WHERE project=1 AND state='open'")[0]["n"], "W8 open count differs from durable rows")

    def mixed(self):
        entry = {"errors": 0, "warmup_errors": 0, "check": "16 read clients cycle equally through W1/W2/W6/W7/W8 while one ingest and one save client validate receipts for 20 seconds", "duration_requested_seconds": 20}
        self.results["mode"][self.mode]["W9"] = entry
        ready = threading.Barrier(19)
        window = {}
        names = ["W1", "W2", "W6", "W7", "W8"]
        cpu_before = self.cpu()
        driver_cpu_before=time.process_time()
        wal_peak=0
        monitor_stop=threading.Event()
        def observe_wal():
            nonlocal wal_peak
            while not monitor_stop.wait(.05):
                try:wal_peak=max(wal_peak,(ROOT/'work.db-wal').stat().st_size)
                except FileNotFoundError:pass
        monitor=threading.Thread(target=observe_wal,daemon=True)
        if self.mode=='embedded':monitor.start()
        def worker(index, kind):
            client = Client()
            result = {"kind": kind, "values": [], "store": [], "errors": 0, "error_examples": [], "counts": {name: 0 for name in names}}
            rng = random.Random(921 + index)
            turn = index % len(names)
            ready.wait()
            try:
                while time.perf_counter() < window["deadline"]:
                    workload = names[turn % len(names)] if kind == "read" else kind
                    turn += 1
                    try:
                        elapsed, store = self.operation(client, workload, rng)
                        result["values"].append(elapsed)
                        result["store"].append(store)
                        if kind == "read":
                            result["counts"][workload] += 1
                    except Exception as exc:
                        result["errors"] += 1
                        if len(result["error_examples"]) < 3:
                            result["error_examples"].append(f"{type(exc).__name__}: {str(exc)[:250]}")
            finally:
                client.close()
            return result
        with concurrent.futures.ThreadPoolExecutor(max_workers=18) as executor:
            futures = [executor.submit(worker, i, "read") for i in range(16)]
            futures += [executor.submit(worker, 16, "W5"), executor.submit(worker, 17, "W4")]
            window["start"] = time.perf_counter()
            window["deadline"] = window["start"] + 20
            ready.wait()
            outputs = [future.result() for future in futures]
        actual = time.perf_counter() - window["start"]
        monitor_stop.set()
        if self.mode=='embedded':monitor.join()
        entry['driver_cpu_seconds']=round(time.process_time()-driver_cpu_before,4)
        if self.mode=='embedded':entry['wal_peak_mb']=round(wal_peak/(1024*1024),3)
        reads = [value for result in outputs if result["kind"] == "read" for value in result["values"]]
        read_store = [value for result in outputs if result["kind"] == "read" for value in result["store"]]
        entry.update(distribution(reads))
        entry["store_ms"] = distribution(read_store)
        entry["read_mix"] = {name: sum(result["counts"][name] for result in outputs) for name in names}
        entry["reads_per_s"] = round(len(reads) / actual, 3)
        entry["elapsed_seconds"] = round(actual, 4)
        entry["server_cpu_seconds"] = round(self.cpu() - cpu_before, 4)
        for result in outputs:
            entry["errors"] += result["errors"]
            entry.setdefault("error_examples", []).extend(result["error_examples"])
            if result["kind"] in ("W5", "W4"):
                key = "ingest" if result["kind"] == "W5" else "save"
                entry[key + "_ms"] = distribution(result["values"])
                entry[key + "_store_ms"] = distribution(result["store"])
                entry[key + "_errors"] = result["errors"]
        entry["error_examples"] = entry["error_examples"][:8]
        entry["check_passed"] = entry["errors"] == 0 and len(reads) > 0 and entry["ingest_ms"]["samples"] > 0 and entry["save_ms"]["samples"] > 0
        self.checkpoint()
        print(f"{self.mode} W9: p95={entry['p95']} reads/s={entry['reads_per_s']} errors={entry['errors']}", flush=True)

    def registry(self, client):
        proof = {"errors": [], "check_passed": False}
        self.results["extras"]["registry"] = proof
        try:
            document = client.request("/openapi.json", method="GET")[0]
            (SCRATCH / "openapi.json").write_text(json.dumps(document, indent=2) + "\n")
            require(document["openapi"].startswith("3.1"), "OpenAPI not 3.1")
            for name in ("get", "propose", "report"):
                require("/op/" + name in document["paths"], f"OpenAPI missing {name}")
            proof["openapi_bytes"] = len(json.dumps(document).encode())
            client.connection.request("POST", "/op/get", body=b'{"ref_no":"invalid"}', headers={"Content-Type": "application/json"})
            rejection = client.connection.getresponse()
            rejection.read()
            proof["invalid_input_status"] = rejection.status
            require(rejection.status in (400, 422), "HTTP operation accepted invalid typed input")
            conflict_payload = self.save_payload()
            accepted = client.request("/op/propose", conflict_payload)[0]
            self.heads[conflict_payload["ref_no"]] = accepted["no"]
            conflict_payload["cmd"] += "-stale-base"
            before_conflict = self.durable_snapshot()
            client.connection.request("POST", "/op/propose", body=json.dumps(conflict_payload).encode(), headers={"Content-Type": "application/json"})
            conflict = client.connection.getresponse()
            conflict_body = conflict.read()
            proof["version_conflict_status"] = conflict.status
            require(conflict.status == 400 and b"conflict" in conflict_body.lower(), "Stale-base save not rejected as conflict")
            require(before_conflict == self.durable_snapshot(), "Rejected stale-base save changed durable rows/sequence")
            for args, output in ((["--help"], "cli-help.txt"), (["get", "--help"], "cli-get-help.txt")):
                proc = subprocess.run([str(BINARY), *args], capture_output=True, timeout=15)
                (SCRATCH / output).write_bytes(proc.stdout + proc.stderr)
                require(proc.returncode == 0 and bool(proc.stdout), f"CLI {' '.join(args)} failed")
            transcript = []
            stderr_file = (SCRATCH / "mcp-stderr.txt").open("wb")
            proc = subprocess.Popen([str(BINARY), "mcp", "embedded", str(ROOT / "work.db")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr_file)
            selector = selectors.DefaultSelector()
            selector.register(proc.stdout, selectors.EVENT_READ)
            pending = bytearray()
            def send(message):
                wire = json.dumps(message, separators=(",", ":")).encode() + b"\n"
                transcript.append({"direction": "client", "message": message})
                proc.stdin.write(wire)
                proc.stdin.flush()
            def receive(identifier):
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    if b"\n" not in pending:
                        require(bool(selector.select(max(0, deadline - time.monotonic()))), "MCP response timeout")
                        chunk = os.read(proc.stdout.fileno(), 65536)
                        require(bool(chunk), "MCP exited before response")
                        pending.extend(chunk)
                        continue
                    wire, _, rest = pending.partition(b"\n")
                    pending[:] = rest
                    if not wire.strip():
                        continue
                    value = json.loads(wire)
                    transcript.append({"direction": "server", "message": value})
                    if value.get("id") == identifier:
                        require("error" not in value, f"MCP protocol error: {value.get('error')}")
                        return value, len(wire)
                raise TimeoutError("MCP response timeout")
            try:
                send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "casebook-arena", "version": "1"}}})
                initialize, _ = receive(1)
                proof["protocol_revision"] = initialize["result"]["protocolVersion"]
                send({"jsonrpc": "2.0", "method": "notifications/initialized"})
                send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
                listing, byte_count = receive(2)
                proof["tools_list_bytes"] = byte_count
                (SCRATCH / "mcp-tools-list.json").write_text(json.dumps(listing, indent=2) + "\n")
                tools = listing["result"]["tools"]
                require({"get", "propose", "report"}.issubset({tool["name"] for tool in tools}), "MCP registry missing tools")
                require(all("inputSchema" in tool and "outputSchema" in tool for tool in tools), "MCP missing input/output schemas")
                send({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "get", "arguments": {"ref_no": 1}}})
                call, _ = receive(3)
                require(call["result"].get("isError") is not True, "MCP get returned error")
                structured = call["result"].get("structuredContent")
                if structured is None:
                    contents = call["result"]["content"]
                    structured = json.loads(next(block["text"] for block in contents if block["type"] == "text"))
                require(structured["case"]["ref_no"] == 1 and isinstance(structured["body"], dict), "MCP get content incorrect")
            finally:
                proc.stdin.close()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.terminate()
                    proc.wait(timeout=5)
                selector.close()
                stderr_file.close()
                (SCRATCH / "mcp-transcript.json").write_text(json.dumps(transcript, indent=2) + "\n")
            proof["check_passed"] = True
        except Exception as exc:
            proof["errors"].append(f"{type(exc).__name__}: {exc}")
        self.checkpoint()

    def run(self):
        overall_started = time.perf_counter()
        self.results["extras"]["artifact_mb"] = BINARY.stat().st_size / (1024 * 1024)
        self.checkpoint()
        try:
            for mode in ("embedded", "server"):
                self.mode = mode
                self.latest_saves, self.latest_report = [], None
                self.search_counter = 0
                self.heads = {int(r[0]): int(r[1]) for r in self.seed.execute("SELECT ref_no,head_no FROM kase")}
                self.results["mode"][mode] = {}
                self.reset(mode)
                cold = []
                for _ in range(5):
                    try:
                        cold.append(self.start(mode))
                    finally:
                        self.stop()
                self.results["extras"].setdefault("cold_start", {})[mode] = distribution(cold)
                self.start(mode)
                client = Client()
                try:
                    for name in COUNTS:
                        self.workload(client, name)
                    self.mixed()
                    self.results["extras"].setdefault("rss_mb", {})[mode] = round(self.rss(), 3)
                    if mode == "embedded":
                        self.registry(client)
                finally:
                    client.close()
                    self.stop()
                self.checkpoint()
        except Exception as exc:
            self.results["extras"]["fatal_error"] = f"{type(exc).__name__}: {exc}"
            (SCRATCH / "fatal-error.txt").write_text(traceback.format_exc())
            raise
        finally:
            self.stop()
            self.seed.close()
            self.results["extras"]["total_driver_seconds"] = round(time.perf_counter() - overall_started, 3)
            self.results["extras"]["report_generation_cpu_seconds"] = round(self.generation_cpu, 4)
            self.results["extras"]["driver_cpu_seconds"] = round(time.process_time(), 4)
            self.results["extras"]["overall_errors"] = sum(entry.get("errors", 0) + entry.get("warmup_errors", 0) for mode in self.results["mode"].values() for entry in mode.values())
            self.results["extras"]["overall_errors"] += len(self.results["extras"].get("registry", {}).get("errors", [])) + int("fatal_error" in self.results["extras"])
            self.checkpoint()


if __name__ == "__main__":
    Driver().run()
