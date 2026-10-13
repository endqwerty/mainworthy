package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"math/rand/v2"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

type Percentiles struct {
	P50 float64 `json:"p50"`
	P95 float64 `json:"p95"`
	P99 float64 `json:"p99"`
	Max float64 `json:"max"`
}
type Stats struct {
	Percentiles
	Errors       int         `json:"errors"`
	Check        string      `json:"check"`
	Iterations   int         `json:"iterations"`
	Warmup       int         `json:"warmup"`
	WarmupErrors int         `json:"warmupErrors"`
	InProcess    Percentiles `json:"inProcess"`
	ErrorSamples []string    `json:"errorSamples,omitempty"`
}

func percentiles(values []float64) Percentiles {
	if len(values) == 0 {
		return Percentiles{}
	}
	v := append([]float64(nil), values...)
	sort.Float64s(v)
	at := func(p float64) float64 { return v[max(0, int(math.Ceil(p*float64(len(v))))-1)] }
	return Percentiles{at(.50), at(.95), at(.99), v[len(v)-1]}
}

type Measurements struct {
	HTTP, Internal       []float64
	Errors, WarmupErrors int
	Samples              []string
}

func (m *Measurements) Add(ms, internal float64, err error, warm bool) {
	if !warm {
		m.HTTP = append(m.HTTP, ms)
		m.Internal = append(m.Internal, internal)
	}
	if err != nil {
		if warm {
			m.WarmupErrors++
		} else {
			m.Errors++
		}
		if len(m.Samples) < 5 {
			m.Samples = append(m.Samples, err.Error())
		}
	}
}
func (m *Measurements) Stats(check string, warm int) Stats {
	return Stats{percentiles(m.HTTP), m.Errors, check, len(m.HTTP), warm, m.WarmupErrors, percentiles(m.Internal), m.Samples}
}

type HTTPClient struct {
	Base   string
	Client *http.Client
}

func newClient(base string) *HTTPClient {
	return &HTTPClient{base, &http.Client{Timeout: 90 * time.Second, Transport: &http.Transport{MaxIdleConns: 64, MaxIdleConnsPerHost: 64, MaxConnsPerHost: 64, DisableCompression: true}}}
}
func (c *HTTPClient) Close() { c.Client.CloseIdleConnections() }
func (c *HTTPClient) Call(ctx context.Context, path string, in, out any) (ms, internal float64, err error) {
	start := time.Now()
	defer func() { ms = float64(time.Since(start)) / float64(time.Millisecond) }()
	data, err := json.Marshal(in)
	if err != nil {
		return 0, 0, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", c.Base+path, bytes.NewReader(data))
	if err != nil {
		return 0, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.Client.Do(req)
	if err != nil {
		return 0, 0, err
	}
	defer res.Body.Close()
	internal, err = strconv.ParseFloat(res.Header.Get("X-Operation-Ms"), 64)
	if err != nil {
		return 0, 0, err
	}
	if res.StatusCode != 200 {
		data, _ := io.ReadAll(res.Body)
		return 0, internal, fmt.Errorf("HTTP %d: %.400s", res.StatusCode, data)
	}
	err = json.NewDecoder(res.Body).Decode(out)
	return 0, internal, err
}

type ChildServer struct {
	Cmd  *exec.Cmd
	Base string
	cold float64
}

func startServer(ctx context.Context, mode, db string) (*ChildServer, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, exe, "serve", "--mode", mode, "--db", db)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = os.Stderr
	start := time.Now()
	if err = cmd.Start(); err != nil {
		return nil, err
	}
	var ready struct {
		Listen string `json:"listen"`
	}
	if err = json.NewDecoder(stdout).Decode(&ready); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, err
	}
	res, err := http.Get(ready.Listen + "/health")
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, err
	}
	_, err = io.Copy(io.Discard, res.Body)
	res.Body.Close()
	if err != nil || res.StatusCode != 200 {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, errors.New("health request failed")
	}
	return &ChildServer{cmd, ready.Listen, float64(time.Since(start)) / float64(time.Millisecond)}, nil
}
func (s *ChildServer) Close() { _ = s.Cmd.Process.Signal(syscall.SIGTERM); _ = s.Cmd.Wait() }

type Metadata struct {
	Keys, Commits, Queries []string
	FolderMax              map[int64]int64
}

func loadMetadata(ctx context.Context, store Queries, queryPath string) (Metadata, error) {
	meta := Metadata{FolderMax: map[int64]int64{}}
	rows, err := store.Query(ctx, "SELECT key FROM test WHERE id BETWEEN 1 AND 9900 ORDER BY id")
	if err != nil {
		return meta, err
	}
	for rows.Next() {
		var key string
		if err = rows.Scan(&key); err != nil {
			rows.Close()
			return meta, err
		}
		meta.Keys = append(meta.Keys, key)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return meta, err
	}
	if len(meta.Keys) != 9900 {
		return meta, errors.New("seed must contain 9900 existing test keys")
	}
	rows, err = store.Query(ctx, "SELECT commit_sha FROM run WHERE id BETWEEN 1 AND 200 ORDER BY id")
	if err != nil {
		return meta, err
	}
	for rows.Next() {
		var commit string
		if err = rows.Scan(&commit); err != nil {
			rows.Close()
			return meta, err
		}
		meta.Commits = append(meta.Commits, commit)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return meta, err
	}
	if len(meta.Commits) != 200 {
		return meta, errors.New("seed must contain 200 runs")
	}
	rows, err = store.Query(ctx, "SELECT folder,max(rank) FROM kase WHERE project=1 GROUP BY folder")
	if err != nil {
		return meta, err
	}
	for rows.Next() {
		var id, rank int64
		if err = rows.Scan(&id, &rank); err != nil {
			rows.Close()
			return meta, err
		}
		meta.FolderMax[id] = rank
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return meta, err
	}
	data, err := os.ReadFile(queryPath)
	if err != nil {
		return meta, err
	}
	meta.Queries = strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(meta.Queries) != 500 {
		return meta, fmt.Errorf("expected 500 queries; found %d", len(meta.Queries))
	}
	return meta, nil
}

func reportInput(meta Metadata, key string) ReportInput {
	in := ReportInput{Key: key, Commit: digest(key)[:40], Results: make([]ResultInput, 10000)}
	for i := range in.Results {
		testKey := "arena:" + key + ":" + strconv.Itoa(i)
		if i < 9900 {
			testKey = meta.Keys[i]
		}
		r := ResultInput{Key: testKey, Outcome: "pass", Duration: int64(10 + i%100)}
		if i < 200 {
			r.Outcome = "fail"
			group := i % 20
			if group < 10 {
				r.Message = fmt.Sprintf("sig%d", group+1)
			} else {
				r.Message = fmt.Sprintf("batch %s group %d %s", key, group, strings.Repeat("expected receipt to match observed value; ", 9))
			}
		}
		in.Results[i] = r
	}
	return in
}

func saveInput(ref, base int64, command string) SaveInput {
	expected := "The confirmation is visible and the mainworthy stores the expected result."
	return SaveInput{command, ref, base, Body{
		Title: "arenaunique" + strings.ReplaceAll(command, "-", "") + " receipt", Pre: "Signed in with permission to author test cases.",
		Steps:   []Step{{"s1", "Open the receipt and inspect the current amount, currency, customer and tax details.", &expected}, {"s2", "Change the amount and submit the receipt using the primary action.", &expected}},
		Methods: []Method{{"human"}}, Intent: Intent{"none"}, Fields: map[string]string{},
	}}
}

func readInput(meta Metadata, rng *rand.Rand, workload string) any {
	switch workload {
	case "W1":
		return GetInput{1 + rng.Int64N(100000)}
	case "W2":
		folder := 21 + rng.Int64N(480)
		return ListInput{folder, rng.Int64N(max(1, meta.FolderMax[folder]-50000))}
	case "W6":
		return RecentInput{1 + rng.Int64N(20000)}
	case "W7":
		return GateInput{meta.Commits[rng.IntN(len(meta.Commits))]}
	case "W8":
		return QueueInput{0}
	}
	panic("unknown read")
}
func executeRead(ctx context.Context, client *HTTPClient, workload string, input any) (float64, float64, error) {
	switch workload {
	case "W1":
		var out CaseOutput
		ms, internal, err := client.Call(ctx, "/ops/get", input, &out)
		if err == nil && (out.Ref != input.(GetInput).Ref || out.Head < 1 || out.Body.Title != out.Title || len(out.Body.Steps) == 0) {
			err = errors.New("W1 ref/body/head mismatch")
		}
		return ms, internal, err
	case "W2":
		var out ListOutput
		ms, internal, err := client.Call(ctx, "/work/W2", input, &out)
		in := input.(ListInput)
		if err == nil && (len(out.Items) != 50 || out.Open < 50000 || out.Reads > 3) {
			err = fmt.Errorf("W2 page/count/read mismatch: rows=%d open=%d reads=%d", len(out.Items), out.Open, out.Reads)
		}
		for _, item := range out.Items {
			if item.Folder != in.Folder || item.Rank <= in.Cursor || int(item.Tests) != len(item.Last) {
				err = errors.New("W2 cursor/glyph mismatch")
			}
			in.Cursor = item.Rank
		}
		return ms, internal, err
	case "W6":
		var out RecentOutput
		ms, internal, err := client.Call(ctx, "/work/W6", input, &out)
		if err == nil && len(out.Items) != 20 {
			err = errors.New("W6 expected 20 results")
		}
		var seq int64 = math.MaxInt64
		for _, item := range out.Items {
			if item.Test != input.(RecentInput).Test || item.Seq > seq {
				err = errors.New("W6 test/order mismatch")
			}
			seq = item.Seq
		}
		return ms, internal, err
	case "W7":
		var out GateOutput
		ms, internal, err := client.Call(ctx, "/work/W7", input, &out)
		if err == nil && (out.Commit != input.(GateInput).Commit || !json.Valid(out.Tally)) {
			err = errors.New("W7 commit/tally mismatch")
		}
		return ms, internal, err
	case "W8":
		var out QueueOutput
		ms, internal, err := client.Call(ctx, "/work/W8", input, &out)
		if err == nil && (len(out.Items) != 50 || out.Open < 50000) {
			err = errors.New("W8 page/count mismatch")
		}
		for _, item := range out.Items {
			if item.State != "open" || item.Evidence == "" || !json.Valid([]byte(item.Evidence)) {
				err = errors.New("W8 state/evidence mismatch")
			}
		}
		return ms, internal, err
	}
	return 0, 0, errors.New("unknown workload")
}

type Snapshot struct{ Seq, Commands, Versions, Questions, Decisions, Results, Tests, Signatures, Batches int64 }

func snapshot(ctx context.Context, s Queries) (Snapshot, error) {
	var out Snapshot
	err := one(ctx, s, `SELECT (SELECT seq FROM project WHERE id=1),(SELECT count(*) FROM command),(SELECT count(*) FROM version),
	 (SELECT count(*) FROM question),(SELECT count(*) FROM decision),(SELECT count(*) FROM result),(SELECT count(*) FROM test),
	 (SELECT count(*) FROM signature),(SELECT count(*) FROM batch)`, nil,
		&out.Seq, &out.Commands, &out.Versions, &out.Questions, &out.Decisions, &out.Results, &out.Tests, &out.Signatures, &out.Batches)
	return out, err
}

func benchMain(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("bench", flag.ContinueOnError)
	mode := fs.String("mode", "embedded", "Store mode")
	db := fs.String("db", "work.db", "SQLite file")
	outPath := fs.String("out", "embedded.json", "Result file")
	queries := fs.String("queries", "queries.txt", "Fixed query file")
	if err := fs.Parse(args); err != nil {
		return err
	}
	store, err := OpenStore(ctx, *mode, *db)
	if err != nil {
		return err
	}
	defer store.Close()
	meta, err := loadMetadata(ctx, store, *queries)
	if err != nil {
		return err
	}
	var cold []float64
	for i := 0; i < 5; i++ {
		server, err := startServer(ctx, *mode, *db)
		if err != nil {
			return err
		}
		cold = append(cold, server.cold)
		server.Close()
	}
	server, err := startServer(ctx, *mode, *db)
	if err != nil {
		return err
	}
	defer server.Close()
	client := newClient(server.Base)
	defer client.Close()
	results := map[string]any{}
	rng := rand.New(rand.NewPCG(17, 29))
	for _, workload := range []string{"W1", "W2", "W3", "W4", "W5", "W5a", "W6", "W7", "W8"} {
		iterations := map[string]int{"W1": 2000, "W2": 1000, "W3": 500, "W4": 1000, "W5": 20, "W5a": 20, "W6": 2000, "W7": 2000, "W8": 1000}[workload]
		fmt.Fprintf(os.Stderr, "%s %s: 100 warmups + %d samples\n", *mode, workload, iterations)
		m := Measurements{}
		before, err := snapshot(ctx, store)
		if err != nil {
			return err
		}
		var replays []SaveInput
		var receipts []SaveOutput
		var searchMatches, searchNonempty int
		junit := GenerateJUnit()
		if workload == "W5a" {
			if err = os.WriteFile("junit.xml", junit, 0600); err != nil {
				return err
			}
		}
		for i := 0; i < 100+iterations; i++ {
			warm := i < 100
			switch workload {
			case "W3":
				in := SearchInput{Text: meta.Queries[(i+400)%500]}
				if i%5 == 0 {
					in.Area = 1 + rng.Int64N(20)
				}
				var out SearchOutput
				ms, internal, err := client.Call(ctx, "/work/W3", in, &out)
				if err == nil && len(out.Items) > 50 {
					err = errors.New("W3 returned too many results")
				}
				if !warm {
					searchMatches += len(out.Items)
					if len(out.Items) > 0 {
						searchNonempty++
					}
				}
				for _, item := range out.Items {
					if in.Area > 0 && (item.Folder < 21+(in.Area-1)*24 || item.Folder > 44+(in.Area-1)*24) {
						err = errors.New("W3 area filter mismatch")
					}
				}
				m.Add(ms, internal, err, warm)
			case "W4":
				ref := int64(80001 + i)
				var current CaseOutput
				_, _, err := client.Call(ctx, "/ops/get", GetInput{ref}, &current)
				if err != nil {
					return err
				}
				in := saveInput(ref, current.Head, fmt.Sprintf("%s-save-%d", *mode, i))
				var out SaveOutput
				ms, internal, err := client.Call(ctx, "/ops/propose", in, &out)
				if err == nil && (out.Case != current.ID || out.Version != current.Head+1 || out.Hash == current.Hash || out.Question == 0 || out.Decision == 0) {
					err = errors.New("W4 receipt mismatch")
				}
				m.Add(ms, internal, err, warm)
				if !warm && len(replays) < 20 {
					replays = append(replays, in)
					receipts = append(receipts, out)
				}
			case "W5":
				in := reportInput(meta, fmt.Sprintf("%s-report-%d", *mode, i))
				var out ReportOutput
				ms, internal, err := client.Call(ctx, "/ops/report", in, &out)
				if err == nil && (out.Inserted != 10000 || out.NewTests != 100 || out.Failures != 200 || out.Signatures != 20 || out.NewSignatures != 10 || out.Replay) {
					err = fmt.Errorf("W5 receipt mismatch: %+v", out)
				}
				m.Add(ms, internal, err, warm)
			case "W5a":
				start := time.Now()
				parsed, err := ParseJUnit(junit)
				ms := float64(time.Since(start)) / float64(time.Millisecond)
				failures := 0
				for _, r := range parsed {
					if r.Outcome == "fail" {
						failures++
						if len(r.Message) < 390 {
							err = errors.New("W5a truncated failure")
						}
					}
				}
				if err == nil && (len(parsed) != 10000 || failures != 200) {
					err = errors.New("W5a test/failure counts incorrect")
				}
				m.Add(ms, ms, err, warm)
			default:
				ms, internal, err := executeRead(ctx, client, workload, readInput(meta, rng, workload))
				m.Add(ms, internal, err, warm)
			}
		}
		check := map[string]string{"W1": "Requested ref, head and body agree; steps present", "W2": "50 ordered rows after cursor; glyph cardinality; >=50000 open; <=3 reads", "W3": "<=50 ranked matches; 20% area filters checked", "W4": "1100 versions/commands/decisions; 20 identical replay receipts and no writes", "W5": "1200000 results,12000 new tests,1200 new signatures; basis/tally/replay verified", "W5a": "10000 parsed tests,200 failures,>=390-byte failure bodies", "W6": "20 rows for requested test; descending sequence", "W7": "Requested commit; valid tally JSON", "W8": "50 open questions with valid evidence; indexed total"}[workload]
		if workload == "W3" {
			if searchNonempty == 0 {
				return errors.New("W3 no search work returned matches")
			}
			check = fmt.Sprintf("%d returned rows across %d nonempty measured queries; <=50 relevance-ordered rows; 20%% area filters checked", searchMatches, searchNonempty)
		}
		if workload == "W4" {
			after, err := snapshot(ctx, store)
			if err != nil {
				return err
			}
			if after.Seq-before.Seq != 1100 || after.Versions-before.Versions != 1100 || after.Commands-before.Commands != 1100 || after.Decisions-before.Decisions != 1100 || after.Questions-before.Questions != 1100 {
				return fmt.Errorf("W4 persisted count mismatch: before=%+v after=%+v", before, after)
			}
			for i, in := range replays {
				var out SaveOutput
				_, _, err := client.Call(ctx, "/ops/propose", in, &out)
				if err != nil || out != receipts[i] {
					return fmt.Errorf("W4 replay mismatch: %v", err)
				}
			}
			replayed, err := snapshot(ctx, store)
			if err != nil {
				return err
			}
			if replayed != after {
				return errors.New("W4 replay changed persisted rows")
			}
			var match SearchOutput
			_, _, err = client.Call(ctx, "/work/W3", SearchInput{Text: strings.Fields(replays[0].Body.Title)[0]}, &match)
			if err != nil || len(match.Items) != 1 || match.Items[0].ID != receipts[0].Case {
				return errors.New("W4 search replacement not found")
			}
		}
		if workload == "W5" {
			after, err := snapshot(ctx, store)
			if err != nil {
				return err
			}
			if after.Results-before.Results != 1200000 || after.Tests-before.Tests != 12000 || after.Signatures-before.Signatures != 1200 || after.Seq-before.Seq != 120 {
				return fmt.Errorf("W5 persisted count mismatch: before=%+v after=%+v", before, after)
			}
			in := reportInput(meta, *mode+"-report-119")
			var replay ReportOutput
			_, _, err = client.Call(ctx, "/ops/report", in, &replay)
			if err != nil || !replay.Replay {
				return errors.New("W5 replay receipt invalid")
			}
			replayed, err := snapshot(ctx, store)
			if err != nil {
				return err
			}
			if replayed != after {
				return errors.New("W5 replay changed persisted rows")
			}
			if err = checkBatch(ctx, store, replay.Batch); err != nil {
				return err
			}
		}
		stats := m.Stats(check, 100)
		results[workload] = stats
		fmt.Fprintf(os.Stderr, "%s %s p95=%.3fms max=%.3fms errors=%d warmupErrors=%d\n", *mode, workload, stats.P95, stats.Max, stats.Errors, stats.WarmupErrors)
		if err = writeJSON(*outPath, map[string]any{"mode": *mode, "results": results, "coldStart": percentiles(cold), "coldStartSamples": cold}); err != nil {
			return err
		}
	}
	mixed, err := mixedLoad(ctx, client, store, meta, *mode)
	if err != nil {
		return err
	}
	results["W9"] = mixed
	rss := rssMB(server.Cmd.Process.Pid)
	return writeJSON(*outPath, map[string]any{"mode": *mode, "driver": sqliteFlavor, "results": results, "coldStart": percentiles(cold), "coldStartSamples": cold, "residentMB": rss})
}

func checkBatch(ctx context.Context, store Queries, batch int64) error {
	var n, fail, linked, unresolved, bad int64
	err := one(ctx, store, `SELECT count(*),sum(CASE WHEN r.outcome='fail' THEN 1 ELSE 0 END),
	 sum(CASE WHEN r.basis='assumed' THEN 1 ELSE 0 END),sum(CASE WHEN r.basis='unresolved' THEN 1 ELSE 0 END),
	 sum(CASE WHEN (t.case_id IS NOT NULL AND (r.basis!='assumed' OR r.basis_case!=t.case_id OR r.basis_version!=k.head_no))
	 OR (t.case_id IS NULL AND (r.basis!='unresolved' OR r.basis_case IS NOT NULL OR r.basis_version IS NOT NULL)) THEN 1 ELSE 0 END)
	 FROM result r JOIN test t ON t.id=r.test LEFT JOIN kase k ON k.id=t.case_id WHERE r.project=1 AND r.batch=?`, []any{batch}, &n, &fail, &linked, &unresolved, &bad)
	if err != nil {
		return err
	}
	if n != 10000 || fail != 200 || linked != 9900 || unresolved != 100 || bad != 0 {
		return fmt.Errorf("batch stored invariants failed: %d,%d,%d,%d,%d", n, fail, linked, unresolved, bad)
	}
	var pass, skipped int64
	err = one(ctx, store, "SELECT sum(CASE WHEN outcome='pass' THEN 1 ELSE 0 END),sum(CASE WHEN outcome='skip' THEN 1 ELSE 0 END) FROM result WHERE project=1 AND batch=?", []any{batch}, &pass, &skipped)
	if err != nil {
		return err
	}
	var tally string
	err = one(ctx, store, "SELECT r.tally FROM run r JOIN target t ON t.project=r.project AND t.commit_sha=r.commit_sha JOIN batch b ON b.target=t.id WHERE b.id=?", []any{batch}, &tally)
	if err != nil {
		return err
	}
	var counts map[string]int64
	if err = json.Unmarshal([]byte(tally), &counts); err != nil {
		return err
	}
	if counts["pass"] != pass || counts["unexplained"] != fail || counts["skip"] != skipped {
		return fmt.Errorf("run tally mismatch: actual pass=%d skip=%d fail=%d; stored %s", pass, skipped, fail, tally)
	}
	return nil
}

func writeJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0600)
}
func rssMB(pid int) float64 {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return -1
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "VmRSS:") {
			fields := strings.Fields(line)
			n, _ := strconv.ParseFloat(fields[1], 64)
			return n / 1024
		}
	}
	return -1
}

type MixedStats struct {
	Stats
	ReadsPerSecond float64 `json:"readsPerSecond"`
	ReadCount      int     `json:"readCount"`
	Seconds        float64 `json:"seconds"`
	Ingest         Stats   `json:"ingest"`
	Save           Stats   `json:"save"`
}

func mixedLoad(ctx context.Context, client *HTTPClient, store *Store, meta Metadata, mode string) (MixedStats, error) {
	fmt.Fprintf(os.Stderr, "%s W9: 16 readers + 2 writers for 20 seconds\n", mode)
	start := time.Now()
	deadline := start.Add(20 * time.Second)
	var mu sync.Mutex
	read := Measurements{}
	ingest := Measurements{}
	save := Measurements{}
	var wait sync.WaitGroup
	var saves, ingests atomic.Int64
	workloads := []string{"W1", "W2", "W6", "W7", "W8"}
	for worker := 0; worker < 16; worker++ {
		wait.Add(1)
		go func(worker int) {
			defer wait.Done()
			rng := rand.New(rand.NewPCG(uint64(worker+1), 71))
			i := worker
			for time.Now().Before(deadline) {
				w := workloads[i%5]
				i++
				ms, internal, err := executeRead(ctx, client, w, readInput(meta, rng, w))
				mu.Lock()
				read.Add(ms, internal, err, false)
				mu.Unlock()
			}
		}(worker)
	}
	wait.Add(1)
	go func() {
		defer wait.Done()
		for time.Now().Before(deadline) {
			i := ingests.Add(1)
			in := reportInput(meta, fmt.Sprintf("%s-mix-report-%d", mode, i))
			var out ReportOutput
			ms, internal, err := client.Call(ctx, "/ops/report", in, &out)
			if err == nil && (out.Inserted != 10000 || out.NewTests != 100 || out.NewSignatures != 10 || out.Failures != 200) {
				err = errors.New("mixed report receipt invalid")
			}
			mu.Lock()
			ingest.Add(ms, internal, err, false)
			mu.Unlock()
		}
	}()
	wait.Add(1)
	go func() {
		defer wait.Done()
		ref := int64(95000)
		var current CaseOutput
		_, _, err := client.Call(ctx, "/ops/get", GetInput{ref}, &current)
		if err != nil {
			mu.Lock()
			save.Add(0, 0, err, false)
			mu.Unlock()
			return
		}
		base := current.Head
		for time.Now().Before(deadline) {
			i := saves.Add(1)
			in := saveInput(ref, base, fmt.Sprintf("%s-mix-save-%d", mode, i))
			var out SaveOutput
			ms, internal, err := client.Call(ctx, "/ops/propose", in, &out)
			if err == nil {
				base = out.Version
			}
			mu.Lock()
			save.Add(ms, internal, err, false)
			mu.Unlock()
		}
	}()
	wait.Wait()
	seconds := time.Since(start).Seconds()
	out := MixedStats{read.Stats("16 clients, equal rotating mix; row invariants checked; separate writers", 0), float64(len(read.HTTP)) / seconds, len(read.HTTP), seconds, ingest.Stats("10000 results per successful ingest", 0), save.Stats("Expected base advances per successful save", 0)}
	if len(ingest.HTTP) == 0 || len(save.HTTP) == 0 {
		return out, errors.New("mixed writers did not run")
	}
	fmt.Fprintf(os.Stderr, "%s W9 read p95=%.3fms reads/s=%.1f ingest max=%.3fms save p95=%.3fms errors=%d/%d/%d\n", mode, out.P95, out.ReadsPerSecond, out.Ingest.Max, out.Save.P95, out.Errors, out.Ingest.Errors, out.Save.Errors)
	return out, nil
}

func driverProbe(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("driver-probe", flag.ContinueOnError)
	path := fs.String("db", "work.db", "SQLite file")
	outPath := fs.String("out", "probe.json", "Output")
	if err := fs.Parse(args); err != nil {
		return err
	}
	store, err := OpenStore(ctx, "embedded", *path)
	if err != nil {
		return err
	}
	defer store.Close()
	meta, err := loadMetadata(ctx, store, "queries.txt")
	if err != nil {
		return err
	}
	server, err := startServer(ctx, "embedded", *path)
	if err != nil {
		return err
	}
	defer server.Close()
	client := newClient(server.Base)
	defer client.Close()
	results := map[string]Stats{}
	rng := rand.New(rand.NewPCG(13, 17))
	for _, workload := range []string{"W1", "W2", "W3", "W4", "W5"} {
		m := Measurements{}
		n := 200
		warm := 100
		if workload == "W3" {
			n = 100
		}
		if workload == "W5" {
			n = 3
			warm = 1
		}
		for i := 0; i < warm+n; i++ {
			var ms, internal float64
			var err error
			switch workload {
			case "W1":
				ms, internal, err = executeRead(ctx, client, workload, readInput(meta, rng, workload))
			case "W2":
				ms, internal, err = executeRead(ctx, client, workload, readInput(meta, rng, workload))
			case "W3":
				var out SearchOutput
				ms, internal, err = client.Call(ctx, "/work/W3", SearchInput{Text: meta.Queries[i%500]}, &out)
				if err == nil && len(out.Items) > 50 {
					err = errors.New("search mismatch")
				}
			case "W4":
				ref := int64(85000 + i)
				var current CaseOutput
				_, _, e := client.Call(ctx, "/ops/get", GetInput{ref}, &current)
				if e != nil {
					return e
				}
				var out SaveOutput
				ms, internal, err = client.Call(ctx, "/ops/propose", saveInput(ref, current.Head, fmt.Sprintf("probe-save-%d", i)), &out)
			case "W5":
				var out ReportOutput
				in := reportInput(meta, fmt.Sprintf("probe-report-%d", i))
				ms, internal, err = client.Call(ctx, "/ops/report", in, &out)
				if err == nil && (out.Inserted != 10000 || out.NewSignatures != 10) {
					err = errors.New("ingest mismatch")
				}
			}
			m.Add(ms, internal, err, i < warm)
		}
		results[workload] = m.Stats("FTS5 active; decoded reads; persisted saves and reports", warm)
	}
	return writeJSON(*outPath, map[string]any{"driver": sqliteFlavor, "results": results, "residentMB": rssMB(server.Cmd.Process.Pid)})
}

// Read a single line without buffering the child's later output.
func readLine(r io.Reader) (string, error) {
	line, err := bufio.NewReader(r).ReadString('\n')
	return line, err
}
