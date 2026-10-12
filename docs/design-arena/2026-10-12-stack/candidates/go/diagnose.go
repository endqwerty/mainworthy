package main

import (
	"context"
	"fmt"
	"os"
	"runtime/pprof"
	"time"
)

func Diagnose(ctx context.Context, service *Service) error {
	store := service.Store
	result := map[string]any{}
	var version, durability string
	if store.Name() == "server" {
		if err := one(ctx, store, "SELECT version()", nil, &version); err != nil {
			return err
		}
		if err := one(ctx, store, "SHOW synchronous_commit", nil, &durability); err != nil {
			return err
		}
	} else {
		if err := one(ctx, store, "SELECT sqlite_version()", nil, &version); err != nil {
			return err
		}
		var synchronous int64
		if err := one(ctx, store, "PRAGMA synchronous", nil, &synchronous); err != nil {
			return err
		}
		if err := one(ctx, store, "PRAGMA journal_mode", nil, &durability); err != nil {
			return err
		}
		durability = fmt.Sprintf("%s synchronous=%d", durability, synchronous)
	}
	result["version"] = version
	result["durability"] = durability
	queries := map[string]string{
		"openCount":  "SELECT count(*) FROM question WHERE project=1 AND state='open'",
		"folderPage": "SELECT id,ref_no,title FROM kase WHERE project=1 AND folder=21 AND rank>50000 ORDER BY rank LIMIT 50",
		"queueRows":  "SELECT id,evidence FROM question WHERE project=1 AND state='open' AND owner=0 ORDER BY rank LIMIT 50",
	}
	if store.Name() == "server" {
		queries["searchRank"] = `SELECT case_id,ts_rank(tsv,plainto_tsquery('simple','token')) score FROM search_doc WHERE project=1 AND tsv @@ plainto_tsquery('simple','token') ORDER BY score DESC LIMIT 50`
	} else {
		queries["searchSort"] = "SELECT rowid,bm25(search_doc) FROM search_doc WHERE search_doc MATCH 'token' AND project=1 ORDER BY bm25(search_doc),rowid LIMIT 50"
		queries["searchRank"] = "SELECT rowid,rank FROM search_doc WHERE search_doc MATCH 'token' AND project=1 ORDER BY rank LIMIT 50"
	}
	for name, query := range queries {
		var elapsed []float64
		var rowCount int
		for i := 0; i < 110; i++ {
			start := time.Now()
			rows, err := store.Query(ctx, query)
			if err != nil {
				return err
			}
			rowCount = 0
			for rows.Next() {
				rowCount++
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				return err
			}
			if i >= 10 {
				elapsed = append(elapsed, float64(time.Since(start))/float64(time.Millisecond))
			}
		}
		result[name] = map[string]any{"milliseconds": percentiles(elapsed), "rows": rowCount, "query": query}
		prefix := "EXPLAIN QUERY PLAN "
		if store.Name() == "server" {
			prefix = "EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) "
		}
		rows, err := store.Query(ctx, prefix+query)
		if err != nil {
			return err
		}
		var plan []string
		for rows.Next() {
			var line string
			if store.Name() == "server" {
				err = rows.Scan(&line)
			} else {
				var id, parent, unused int64
				err = rows.Scan(&id, &parent, &unused, &line)
			}
			if err != nil {
				rows.Close()
				return err
			}
			plan = append(plan, line)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		result[name+"Plan"] = plan
	}
	if err := writeJSON("diagnostics-"+store.Name()+"-"+sqliteDriver+".json", result); err != nil {
		return err
	}
	if os.Getenv("CASEBOOK_CPU_PROFILE") != "1" {
		return nil
	}
	profile, err := os.Create("cpu-" + store.Name() + "-" + sqliteDriver + ".pprof")
	if err != nil {
		return err
	}
	if err = pprof.StartCPUProfile(profile); err != nil {
		profile.Close()
		return err
	}
	meta, err := loadMetadata(ctx, store, "queries.txt")
	if err != nil {
		pprof.StopCPUProfile()
		profile.Close()
		return err
	}
	until := time.Now().Add(3 * time.Second)
	i := 0
	for time.Now().Before(until) {
		if _, err = service.Search(ctx, SearchInput{Text: "token"}); err != nil {
			pprof.StopCPUProfile()
			profile.Close()
			return err
		}
		if _, err = service.Queue(ctx, QueueInput{}); err != nil {
			pprof.StopCPUProfile()
			profile.Close()
			return err
		}
		i++
		if _, err = service.Report(ctx, reportInput(meta, fmt.Sprintf("diagnose-%d", i))); err != nil {
			pprof.StopCPUProfile()
			profile.Close()
			return err
		}
	}
	pprof.StopCPUProfile()
	if err = profile.Close(); err != nil {
		return err
	}
	return writeJSON("diagnostics-"+store.Name()+"-"+sqliteDriver+".json", result)
}
