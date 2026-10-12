package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

type Service struct{ Store Backend }

func digest(text string) string {
	h := sha256.Sum256([]byte(text))
	return hex.EncodeToString(h[:])
}
func signatureHash(message string) string {
	return digest(strings.Join(strings.Fields(message), " "))[:16]
}

func (s *Service) Get(ctx context.Context, in GetInput) (CaseOutput, error) {
	var out CaseOutput
	var body string
	err := one(ctx, s.Store, `SELECT k.id,k.project,k.ref_no,k.folder,k.rank,k.title,k.head_no,k.head_hash,k.state,k.rev,v.body
	 FROM kase k JOIN version v ON v.case_id=k.id AND v.no=k.head_no WHERE k.project=1 AND k.ref_no=?`, []any{in.Ref},
		&out.ID, &out.Project, &out.Ref, &out.Folder, &out.Rank, &out.Title, &out.Head, &out.Hash, &out.State, &out.Rev, &body)
	if err == nil {
		err = json.Unmarshal([]byte(body), &out.Body)
	}
	return out, err
}

func (s *Service) List(ctx context.Context, in ListInput) (ListOutput, error) {
	out := ListOutput{Items: make([]ListItem, 0, 50), Reads: 3}
	rows, err := s.Store.Query(ctx, `SELECT id,ref_no,folder,rank,title,head_no,head_hash,state,rev FROM kase
	 WHERE project=1 AND folder=? AND rank>? ORDER BY rank LIMIT 50`, in.Folder, in.Cursor)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var item ListItem
		if err = rows.Scan(&item.ID, &item.Ref, &item.Folder, &item.Rank, &item.Title, &item.Head, &item.Hash, &item.State, &item.Rev); err != nil {
			rows.Close()
			return out, err
		}
		item.Last = []TestGlyph{}
		out.Items = append(out.Items, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	if len(out.Items) != 0 {
		args := make([]any, len(out.Items))
		positions := make(map[int64]int, len(out.Items))
		for i, item := range out.Items {
			args[i] = item.ID
			positions[item.ID] = i
		}
		rows, err = s.Store.Query(ctx, `SELECT t.case_id,t.id,COALESCE((SELECT r.outcome FROM result r
		 WHERE r.project=1 AND r.test=t.id ORDER BY r.seq DESC,r.ord DESC LIMIT 1),'none')
		 FROM test t WHERE t.project=1 AND t.case_id IN (`+placeholders(len(args))+`)`, args...)
		if err != nil {
			return out, err
		}
		for rows.Next() {
			var caseID, testID int64
			var outcome string
			if err = rows.Scan(&caseID, &testID, &outcome); err != nil {
				rows.Close()
				return out, err
			}
			i := positions[caseID]
			out.Items[i].Tests++
			out.Items[i].Last = append(out.Items[i].Last, TestGlyph{testID, outcome})
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return out, err
		}
	} else {
		out.Reads = 2
	}
	err = one(ctx, s.Store, "SELECT count(*) FROM question WHERE project=1 AND state='open'", nil, &out.Open)
	return out, err
}

func (s *Service) Search(ctx context.Context, in SearchInput) (SearchOutput, error) {
	out := SearchOutput{Items: []SearchItem{}}
	rows, err := s.Store.SearchRows(ctx, in)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var item SearchItem
		if err = rows.Scan(&item.ID, &item.Ref, &item.Title, &item.Folder, &item.Relevance); err != nil {
			return out, err
		}
		out.Items = append(out.Items, item)
	}
	return out, rows.Err()
}

func (s *Service) Save(ctx context.Context, in SaveInput) (SaveOutput, error) {
	var out SaveOutput
	if in.Command == "" || in.Base <= 0 || in.Body.Title == "" || len(in.Body.Steps) == 0 {
		return out, errors.New("command, base version and case body required")
	}
	body, err := json.Marshal(in.Body)
	if err != nil {
		return out, err
	}
	tx, err := s.Store.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	n, err := tx.Exec(ctx, "INSERT INTO command (id,project,op,actor,seq,outcome) VALUES (?,1,'propose',1,0,'{}') ON CONFLICT(id) DO NOTHING", in.Command)
	if err != nil {
		return out, err
	}
	if n == 0 {
		var stored string
		err = one(ctx, tx, "SELECT outcome FROM command WHERE id=?", []any{in.Command}, &stored)
		if err == nil {
			err = json.Unmarshal([]byte(stored), &out)
		}
		return out, err
	}
	if err = one(ctx, tx, "UPDATE project SET seq=seq+1 WHERE id=1 RETURNING seq", nil, &out.Sequence); err != nil {
		return out, err
	}
	var head, folder int64
	if err = one(ctx, tx, "SELECT id,head_no,folder FROM kase WHERE project=1 AND ref_no=?", []any{in.Ref}, &out.Case, &head, &folder); err != nil {
		return out, err
	}
	if head != in.Base {
		return out, fmt.Errorf("conflict: expected version %d; current %d", in.Base, head)
	}
	out.Version = head + 1
	out.Hash = digest(string(body))
	evidence := fmt.Sprintf(`{"case":%d,"from":%d,"hash":%q}`, out.Case, head, out.Hash)
	query := "INSERT INTO question (id,project,ref_no,kind,fingerprint,epoch,state,owner,rank,evidence,evidence_hash,rev) VALUES (" + s.Store.IDExpr() + ",1,?,'adopt',?,0,'decided',0,?,?,?,?) RETURNING id"
	if err = one(ctx, tx, query, []any{out.Sequence, "adopt:" + in.Command, out.Sequence, evidence, digest(evidence), out.Sequence}, &out.Question); err != nil {
		return out, err
	}
	if err = questionIdentity(ctx, tx, out.Question); err != nil {
		return out, err
	}
	query = "INSERT INTO decision (id,project,question,kind,answer,basis,seq) VALUES (" + s.Store.IDExpr() + ",1,?,'adopt','accept',?,?) RETURNING id"
	if err = one(ctx, tx, query, []any{out.Question, digest(evidence), out.Sequence}, &out.Decision); err != nil {
		return out, err
	}
	n, err = tx.Exec(ctx, "INSERT INTO version (case_id,no,parent,body,hash,claim_hash,seq) VALUES (?,?,?,?,?,?,?)", out.Case, out.Version, head, string(body), out.Hash, out.Hash, out.Sequence)
	if err = requireRows(n, 1, err); err != nil {
		return out, err
	}
	n, err = tx.Exec(ctx, "UPDATE kase SET head_no=?,title=?,head_hash=?,rev=? WHERE id=? AND head_no=?", out.Version, in.Body.Title, out.Hash, out.Sequence, out.Case, head)
	if err = requireRows(n, 1, err); err != nil {
		return out, err
	}
	var text strings.Builder
	text.WriteString(in.Body.Title)
	text.WriteByte(' ')
	text.WriteString(in.Body.Pre)
	for _, step := range in.Body.Steps {
		text.WriteByte(' ')
		text.WriteString(step.Action)
		if step.Expected != nil {
			text.WriteByte(' ')
			text.WriteString(*step.Expected)
		}
	}
	n, err = s.Store.ReplaceSearch(ctx, tx, out.Case, folder, text.String())
	if err = requireRows(n, 1, err); err != nil {
		return out, err
	}
	receipt, err := json.Marshal(out)
	if err != nil {
		return out, err
	}
	n, err = tx.Exec(ctx, "UPDATE command SET seq=?,outcome=? WHERE id=?", out.Sequence, string(receipt), in.Command)
	if err = requireRows(n, 1, err); err != nil {
		return out, err
	}
	err = tx.Commit(ctx)
	return out, err
}

type resolvedTest struct {
	ID         int64
	Case, Head *int64
}

func (s *Service) Report(ctx context.Context, in ReportInput) (ReportOutput, error) {
	var out ReportOutput
	if in.Key == "" || in.Commit == "" || len(in.Results) == 0 {
		return out, errors.New("batch key, commit and results required")
	}
	keys := make(map[string]bool, len(in.Results))
	outcomes := make(map[string]int64)
	for _, r := range in.Results {
		if r.Key == "" || keys[r.Key] {
			return out, errors.New("empty or duplicate test key")
		}
		keys[r.Key] = true
		outcomes[r.Outcome]++
		if r.Outcome != "pass" && r.Outcome != "fail" && r.Outcome != "skip" && r.Outcome != "error" && r.Outcome != "blocked" {
			return out, fmt.Errorf("invalid outcome %q", r.Outcome)
		}
	}
	tx, err := s.Store.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	// The project row is the commit-order lock in both modes. A replay rolls it back.
	if err = one(ctx, tx, "UPDATE project SET seq=seq+1 WHERE id=1 RETURNING seq", nil, &out.Sequence); err != nil {
		return out, err
	}
	err = one(ctx, tx, "SELECT id,seq FROM batch WHERE project=1 AND key=?", []any{in.Key}, &out.Batch, &out.Sequence)
	if err == nil {
		out.Replay = true
		return out, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return out, err
	}
	var target int64
	query := "INSERT INTO target (id,project,commit_sha,env) VALUES (" + s.Store.IDExpr() + ",1,?,'arena') ON CONFLICT(project,commit_sha,env) DO UPDATE SET commit_sha=excluded.commit_sha RETURNING id"
	if err = one(ctx, tx, query, []any{in.Commit}, &target); err != nil {
		return out, err
	}
	query = "INSERT INTO batch (id,project,key,target,job,attempt,state,seq) VALUES (" + s.Store.IDExpr() + ",1,?,?,'arena',1,'processed',?) RETURNING id"
	if err = one(ctx, tx, query, []any{in.Key, target, out.Sequence}, &out.Batch); err != nil {
		return out, err
	}
	tests := make(map[string]resolvedTest, len(in.Results))
	for start := 0; start < len(in.Results); start += 500 {
		end := min(start+500, len(in.Results))
		args := make([]any, end-start)
		for i := start; i < end; i++ {
			args[i-start] = in.Results[i].Key
		}
		rows, err := tx.Query(ctx, "SELECT t.key,t.id,t.case_id,k.head_no FROM test t LEFT JOIN kase k ON k.id=t.case_id WHERE t.project=1 AND t.key IN ("+placeholders(len(args))+")", args...)
		if err != nil {
			return out, err
		}
		for rows.Next() {
			var key string
			var t resolvedTest
			if err = rows.Scan(&key, &t.ID, &t.Case, &t.Head); err != nil {
				rows.Close()
				return out, err
			}
			if t.Case != nil && t.Head == nil {
				rows.Close()
				return out, fmt.Errorf("linked test %q references missing case %d", key, *t.Case)
			}
			tests[key] = t
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return out, err
		}
	}
	for _, r := range in.Results {
		if _, exists := tests[r.Key]; exists {
			continue
		}
		var t resolvedTest
		query = "INSERT INTO test (id,project,key,case_id,file) VALUES (" + s.Store.IDExpr() + ",1,?,NULL,NULL) RETURNING id"
		if err = one(ctx, tx, query, []any{r.Key}, &t.ID); err != nil {
			return out, err
		}
		tests[r.Key] = t
		out.NewTests++
	}
	signatures := map[string]int64{}
	messageByHash := map[string]string{}
	for _, r := range in.Results {
		if r.Outcome == "fail" || r.Outcome == "error" {
			out.Failures++
			h := signatureHash(r.Message)
			messageByHash[h] = r.Message
		}
	}
	for hash, message := range messageByHash {
		var id int64
		err = one(ctx, tx, "SELECT id FROM signature WHERE project=1 AND hash=?", []any{hash}, &id)
		if errors.Is(err, sql.ErrNoRows) {
			query = "INSERT INTO signature (id,project,hash,class,sample) VALUES (" + s.Store.IDExpr() + ",1,?,'assertion',?) ON CONFLICT(project,hash) DO UPDATE SET sample=excluded.sample RETURNING id"
			if err = one(ctx, tx, query, []any{hash, message}, &id); err != nil {
				return out, err
			}
			out.NewSignatures++
		} else if err != nil {
			return out, err
		}
		signatures[hash] = id
		fp := "failure:" + hash
		var existing int64
		err = one(ctx, tx, "SELECT id FROM question WHERE project=1 AND fingerprint=? AND state='open' ORDER BY epoch DESC LIMIT 1", []any{fp}, &existing)
		if errors.Is(err, sql.ErrNoRows) {
			evidenceBytes, e := json.Marshal(map[string]any{"signature": id, "batch": out.Batch, "sample": message})
			if e != nil {
				return out, e
			}
			evidence := string(evidenceBytes)
			query = "INSERT INTO question (id,project,ref_no,kind,fingerprint,epoch,state,owner,rank,evidence,evidence_hash,rev) VALUES (" + s.Store.IDExpr() + ",1,?,'failure',?,0,'open',0,?,?,?,?) RETURNING id"
			var q int64
			if err = one(ctx, tx, query, []any{out.Sequence, fp, out.Sequence, evidence, digest(evidence), out.Sequence}, &q); err != nil {
				return out, err
			}
			if err = questionIdentity(ctx, tx, q); err != nil {
				return out, err
			}
			out.Questions++
		} else if err != nil {
			return out, err
		}
	}
	out.Signatures = int64(len(signatures))
	rows := make([][]any, len(in.Results))
	for i, r := range in.Results {
		t := tests[r.Key]
		basis := "unresolved"
		if t.Case != nil {
			basis = "assumed"
		}
		var sig any
		if r.Outcome == "fail" || r.Outcome == "error" {
			sig = signatures[signatureHash(r.Message)]
		}
		var caseID, head any
		if t.Case != nil {
			caseID = *t.Case
			head = *t.Head
		}
		var message any
		if r.Message != "" {
			message = r.Message
		}
		rows[i] = []any{nil, int64(1), t.ID, out.Sequence, int64(i), out.Batch, target, r.Outcome, basis, caseID, head, r.Duration, sig, message}
	}
	n, err := tx.InsertResults(ctx, rows)
	if err = requireRows(n, int64(len(in.Results)), err); err != nil {
		return out, err
	}
	out.Inserted = n
	tallyBytes, err := json.Marshal(map[string]int64{"pass": outcomes["pass"], "unexplained": out.Failures, "skip": outcomes["skip"], "blocked": outcomes["blocked"], "missing": outcomes["skip"] + outcomes["blocked"]})
	if err != nil {
		return out, err
	}
	tally := string(tallyBytes)
	verdict := "passed"
	if out.Failures > 0 {
		verdict = "blocked"
	} else if outcomes["skip"]+outcomes["blocked"] > 0 {
		verdict = "pending"
	}
	query = "INSERT INTO run (id,project,commit_sha,verdict,tally,outstanding,rev) VALUES (" + s.Store.IDExpr() + ",1,?,?,?,0,?) ON CONFLICT(project,commit_sha) DO UPDATE SET tally=excluded.tally,verdict=excluded.verdict,rev=excluded.rev"
	n, err = tx.Exec(ctx, query, in.Commit, verdict, tally, out.Sequence)
	if err = requireRows(n, 1, err); err != nil {
		return out, err
	}
	err = tx.Commit(ctx)
	return out, err
}

func questionIdentity(ctx context.Context, tx Transaction, id int64) error {
	n, err := tx.Exec(ctx, "UPDATE question SET ref_no=?,rank=? WHERE id=?", id, id*1000, id)
	return requireRows(n, 1, err)
}

func (s *Service) Recent(ctx context.Context, in RecentInput) (RecentOutput, error) {
	out := RecentOutput{Items: []RecentItem{}}
	rows, err := s.Store.Query(ctx, `SELECT id,test,seq,ord,batch,target,outcome,basis,basis_case,basis_version,duration_ms,signature,message
	 FROM result WHERE project=1 AND test=? ORDER BY seq DESC,ord DESC LIMIT 20`, in.Test)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var r RecentItem
		if err = rows.Scan(&r.ID, &r.Test, &r.Seq, &r.Ord, &r.Batch, &r.Target, &r.Outcome, &r.Basis, &r.Case, &r.Version, &r.Duration, &r.Signature, &r.Message); err != nil {
			return out, err
		}
		out.Items = append(out.Items, r)
	}
	return out, rows.Err()
}

func (s *Service) Gate(ctx context.Context, in GateInput) (GateOutput, error) {
	var out GateOutput
	var tally string
	err := one(ctx, s.Store, "SELECT id,commit_sha,verdict,tally,outstanding,next_expiry,rev FROM run WHERE project=1 AND commit_sha=?", []any{in.Commit}, &out.ID, &out.Commit, &out.Verdict, &tally, &out.Outstanding, &out.Expiry, &out.Rev)
	out.Tally = json.RawMessage(tally)
	return out, err
}

func (s *Service) Queue(ctx context.Context, in QueueInput) (QueueOutput, error) {
	out := QueueOutput{Items: []QueueItem{}}
	rows, err := s.Store.Query(ctx, "SELECT id,ref_no,kind,fingerprint,state,owner,rank,evidence,evidence_hash FROM question WHERE project=1 AND state='open' AND owner=? ORDER BY rank LIMIT 50", in.Owner)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var q QueueItem
		if err = rows.Scan(&q.ID, &q.Ref, &q.Kind, &q.Fingerprint, &q.State, &q.Owner, &q.Rank, &q.Evidence, &q.Hash); err != nil {
			rows.Close()
			return out, err
		}
		out.Items = append(out.Items, q)
	}
	err = rows.Err()
	rows.Close()
	if err == nil {
		err = one(ctx, s.Store, "SELECT count(*) FROM question WHERE project=1 AND state='open'", nil, &out.Open)
	}
	return out, err
}
