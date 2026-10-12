package main

import (
	"context"
	"errors"
	"fmt"
	"net/http/httptest"
	"strings"
	"sync"
)

func SelfCheck(ctx context.Context, service *Service) error {
	store := service.Store
	server := httptest.NewServer(NewRegistry(service).Handler(service))
	defer server.Close()
	client := newClient(server.URL)
	defer client.Close()
	meta, err := loadMetadata(ctx, store, "queries.txt")
	if err != nil {
		return err
	}
	var page ListOutput
	if _, _, err = client.Call(ctx, "/work/W2", ListInput{21, 0}, &page); err != nil {
		return err
	}
	linked := 0
	for _, item := range page.Items {
		var tests int64
		if err = one(ctx, store, "SELECT count(*) FROM test WHERE project=1 AND case_id=?", []any{item.ID}, &tests); err != nil {
			return err
		}
		if tests != item.Tests {
			return errors.New("glyph test count differs from stored rows")
		}
		for _, glyph := range item.Last {
			var caseID int64
			var outcome string
			if err = one(ctx, store, "SELECT case_id FROM test WHERE id=?", []any{glyph.Test}, &caseID); err != nil {
				return err
			}
			if err = one(ctx, store, "SELECT outcome FROM result WHERE project=1 AND test=? ORDER BY seq DESC,ord DESC LIMIT 1", []any{glyph.Test}, &outcome); err != nil {
				return err
			}
			if caseID != item.ID || outcome != glyph.Outcome {
				return errors.New("glyph case/outcome differs from stored rows")
			}
			linked++
		}
	}
	if linked == 0 {
		return errors.New("linked glyph page exercised no linked tests")
	}
	before, err := snapshot(ctx, store)
	if err != nil {
		return err
	}
	var original CaseOutput
	if _, _, err = client.Call(ctx, "/ops/get", GetInput{70000}, &original); err != nil {
		return err
	}
	invalid := saveInput(100001, 1, "selfcheck-missing-case")
	var ignored SaveOutput
	if _, _, err = client.Call(ctx, "/ops/propose", invalid, &ignored); err == nil {
		return errors.New("save of missing case succeeded")
	}
	after, err := snapshot(ctx, store)
	if err != nil {
		return err
	}
	if after != before {
		return errors.New("failed save was not rolled back")
	}
	stale := saveInput(original.Ref, original.Head+10, "selfcheck-stale")
	if _, _, err = client.Call(ctx, "/ops/propose", stale, &ignored); err == nil {
		return errors.New("stale base accepted")
	}
	after, err = snapshot(ctx, store)
	if err != nil {
		return err
	}
	if after != before {
		return errors.New("stale save wrote records")
	}
	in := saveInput(original.Ref, original.Head, "selfcheck-concurrent-replay")
	var outputs [2]SaveOutput
	var failures [2]error
	var wait sync.WaitGroup
	for i := range outputs {
		wait.Add(1)
		go func(i int) { defer wait.Done(); _, _, failures[i] = client.Call(ctx, "/ops/propose", in, &outputs[i]) }(i)
	}
	wait.Wait()
	if failures[0] != nil || failures[1] != nil || outputs[0] != outputs[1] {
		return fmt.Errorf("concurrent replay mismatch: %v %v", failures[0], failures[1])
	}
	after, err = snapshot(ctx, store)
	if err != nil {
		return err
	}
	if after.Seq-before.Seq != 1 || after.Commands-before.Commands != 1 || after.Versions-before.Versions != 1 || after.Questions-before.Questions != 1 || after.Decisions-before.Decisions != 1 {
		return errors.New("save did not commit exactly one complete record")
	}
	var current CaseOutput
	if _, _, err = client.Call(ctx, "/ops/get", GetInput{70000}, &current); err != nil {
		return err
	}
	if current.Hash != outputs[0].Hash || current.Body.Title != in.Body.Title || current.Head != original.Head+1 {
		return errors.New("head/body/hash not committed together")
	}
	var matches SearchOutput
	if _, _, err = client.Call(ctx, "/work/W3", SearchInput{Text: "token receipt", Area: 1}, &matches); err != nil {
		return err
	}
	if len(matches.Items) == 0 {
		return errors.New("compound seeded FTS query returned no matches")
	}
	for i, item := range matches.Items {
		if item.Folder < 21 || item.Folder > 44 {
			return errors.New("compound FTS query escaped area")
		}
		var c CaseOutput
		if _, _, err = client.Call(ctx, "/ops/get", GetInput{item.Ref}, &c); err != nil {
			return err
		}
		text := c.Body.Title + " " + c.Body.Pre
		for _, step := range c.Body.Steps {
			text += " " + step.Action
			if step.Expected != nil {
				text += " " + *step.Expected
			}
		}
		text = strings.ToLower(text)
		if !strings.Contains(text, "token") || !strings.Contains(text, "receipt") {
			return errors.New("FTS did not AND the query terms")
		}
		if i > 0 && ((store.Name() == "embedded" && item.Relevance < matches.Items[i-1].Relevance) || (store.Name() == "server" && item.Relevance > matches.Items[i-1].Relevance)) {
			return errors.New("FTS relevance order incorrect")
		}
	}
	var count int64
	err = one(ctx, store, "SELECT count(*) FROM decision d JOIN question q ON q.id=d.question WHERE d.id=? AND q.id=? AND q.state='decided' AND d.seq=? AND q.rev=?", []any{outputs[0].Decision, outputs[0].Question, outputs[0].Sequence, outputs[0].Sequence}, &count)
	if err != nil || count != 1 {
		return errors.New("adopt decision/question not linked")
	}
	before = after
	report := reportInput(meta, "selfcheck-report")
	for i := 200; i < 209; i++ {
		report.Results[i].Outcome = "skip"
	}
	var receipt ReportOutput
	if _, _, err = client.Call(ctx, "/ops/report", report, &receipt); err != nil {
		return err
	}
	if receipt.Inserted != 10000 || receipt.NewTests != 100 || receipt.NewSignatures != 10 || receipt.Failures != 200 || receipt.Signatures != 20 {
		return fmt.Errorf("report receipt incorrect: %+v", receipt)
	}
	if err = checkBatch(ctx, store, receipt.Batch); err != nil {
		return err
	}
	var qcount, qrefs, qranks int64
	if err = one(ctx, store, "SELECT count(*),count(DISTINCT ref_no),count(DISTINCT rank) FROM question WHERE project=1 AND rev=?", []any{receipt.Sequence}, &qcount, &qrefs, &qranks); err != nil {
		return err
	}
	if qcount != qrefs || qcount != qranks {
		return errors.New("report question references/ranks are not distinct")
	}
	after, err = snapshot(ctx, store)
	if err != nil {
		return err
	}
	if after.Seq-before.Seq != 1 || after.Results-before.Results != 10000 || after.Tests-before.Tests != 100 || after.Signatures-before.Signatures != 10 || after.Batches-before.Batches != 1 {
		return errors.New("report persisted counts incorrect")
	}
	var replay ReportOutput
	if _, _, err = client.Call(ctx, "/ops/report", report, &replay); err != nil {
		return err
	}
	if !replay.Replay || replay.Batch != receipt.Batch || replay.Sequence != receipt.Sequence {
		return errors.New("batch replay receipt incorrect")
	}
	replayed, err := snapshot(ctx, store)
	if err != nil {
		return err
	}
	if replayed != after {
		return errors.New("report replay wrote rows")
	}
	var gate GateOutput
	if _, _, err = client.Call(ctx, "/work/W7", GateInput{report.Commit}, &gate); err != nil {
		return err
	}
	if gate.Verdict != "blocked" || gate.Rev != receipt.Sequence {
		return errors.New("report run tally not committed")
	}
	invalidReport := reportInput(meta, "selfcheck-invalid-report")
	invalidReport.Results[9999].Outcome = "invalid"
	if _, _, err = client.Call(ctx, "/ops/report", invalidReport, &receipt); err == nil {
		return errors.New("invalid outcome accepted")
	}
	replayed, err = snapshot(ctx, store)
	if err != nil {
		return err
	}
	if replayed != after {
		return errors.New("invalid report wrote rows")
	}
	changed, err := store.Exec(ctx, "UPDATE test SET case_id=9999999 WHERE id=1")
	if err = requireRows(changed, 1, err); err != nil {
		return err
	}
	orphan := reportInput(meta, "selfcheck-orphan-report")
	_, _, err = client.Call(ctx, "/ops/report", orphan, &receipt)
	if err == nil || !strings.Contains(err.Error(), "HTTP 400:") {
		return fmt.Errorf("orphan link did not return HTTP 400: %v", err)
	}
	replayed, err = snapshot(ctx, store)
	if err != nil {
		return err
	}
	if replayed != after {
		return errors.New("orphan report wrote rows")
	}
	changed, err = store.Exec(ctx, "UPDATE test SET case_id=1 WHERE id=1")
	if err = requireRows(changed, 1, err); err != nil {
		return err
	}
	parsed, err := ParseJUnit(GenerateJUnit())
	if err != nil {
		return err
	}
	fail := 0
	for _, r := range parsed {
		if r.Outcome == "fail" {
			fail++
		}
	}
	if len(parsed) != 10000 || fail != 200 {
		return errors.New("JUnit counts incorrect")
	}
	fmt.Printf("PASS mode=%s: real HTTP; atomic save/report; stale-base and missing-case rollback; concurrent command replay; batch replay; evidence bases; skip tally 9791/200/9; unique question refs/ranks; stored glyph oracle; orphan link rollback; JUnit 10000/200\n", store.Name())
	return nil
}
