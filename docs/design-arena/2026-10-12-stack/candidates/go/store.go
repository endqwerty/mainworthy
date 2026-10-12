package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Rows interface {
	Next() bool
	Scan(...any) error
	Err() error
	Close()
}

type Queries interface {
	Query(context.Context, string, ...any) (Rows, error)
	Exec(context.Context, string, ...any) (int64, error)
}

type Backend interface {
	Queries
	Begin(context.Context) (Transaction, error)
	IDExpr() string
	SearchRows(context.Context, SearchInput) (Rows, error)
	ReplaceSearch(context.Context, Transaction, int64, int64, string) (int64, error)
	Name() string
}

type Transaction interface {
	Queries
	Commit(context.Context) error
	Rollback(context.Context) error
	InsertResults(context.Context, [][]any) (int64, error)
}

type Store struct {
	Mode           string
	Reader, Writer *sql.DB
	PG             *pgxpool.Pool
	mu             sync.Mutex
	stmts          map[string]*sql.Stmt
}

func (s *Store) Name() string { return s.Mode }

func (s *Store) SearchRows(ctx context.Context, in SearchInput) (Rows, error) {
	words := strings.Fields(in.Text)
	if len(words) == 0 {
		return nil, errors.New("empty search")
	}
	filter := ""
	args := []any{}
	if s.PG != nil {
		args = append(args, in.Text)
		if in.Area > 0 {
			filter = " AND d.folder BETWEEN ? AND ?"
			args = append(args, 21+(in.Area-1)*24, 44+(in.Area-1)*24)
		}
		return s.Query(ctx, `WITH hits AS MATERIALIZED (
		 SELECT d.case_id,ts_rank(d.tsv,q.query) AS score
		 FROM search_doc d CROSS JOIN plainto_tsquery('simple', ?) q(query)
		 WHERE d.project=1 AND d.tsv @@ q.query`+filter+` ORDER BY score DESC,d.case_id LIMIT 50)
		 SELECT k.id,k.ref_no,k.title,k.folder,h.score FROM hits h JOIN kase k ON k.id=h.case_id
		 ORDER BY h.score DESC,k.id`, args...)
	}
	for i, word := range words {
		words[i] = `"` + strings.ReplaceAll(word, `"`, `""`) + `"`
	}
	args = append(args, strings.Join(words, " AND "))
	if in.Area > 0 {
		filter = " AND search_doc.folder BETWEEN ? AND ?"
		args = append(args, 21+(in.Area-1)*24, 44+(in.Area-1)*24)
	}
	return s.Query(ctx, `SELECT k.id,k.ref_no,k.title,k.folder,search_doc.rank
	 FROM search_doc JOIN kase k ON k.id=search_doc.rowid WHERE search_doc MATCH ? AND search_doc.project=1`+filter+`
	 ORDER BY search_doc.rank LIMIT 50`, args...)
}

func (s *Store) ReplaceSearch(ctx context.Context, tx Transaction, caseID, folder int64, text string) (int64, error) {
	if s.PG != nil {
		return tx.Exec(ctx, "INSERT INTO search_doc (case_id,project,folder,text) VALUES (?,1,?,?) ON CONFLICT(case_id) DO UPDATE SET text=excluded.text,folder=excluded.folder", caseID, folder, text)
	}
	n, err := tx.Exec(ctx, "DELETE FROM search_doc WHERE rowid=?", caseID)
	if err = requireRows(n, 1, err); err != nil {
		return 0, err
	}
	return tx.Exec(ctx, "INSERT INTO search_doc (rowid,text,project,folder) VALUES (?,?,1,?)", caseID, text, folder)
}

type sqlRows struct{ *sql.Rows }

func (r sqlRows) Close() { _ = r.Rows.Close() }

func OpenStore(ctx context.Context, mode, path string) (*Store, error) {
	s := &Store{Mode: mode, stmts: make(map[string]*sql.Stmt)}
	if mode == "server" {
		config, err := pgxpool.ParseConfig("postgres://postgres@127.0.0.1:54329/cb_go?sslmode=disable")
		if err != nil {
			return nil, err
		}
		config.MaxConns = 20
		config.MinConns = 2
		config.ConnConfig.RuntimeParams["synchronous_commit"] = "on"
		config.ConnConfig.StatementCacheCapacity = 256
		s.PG, err = pgxpool.NewWithConfig(ctx, config)
		if err == nil {
			err = s.PG.Ping(ctx)
		}
		return s, err
	}
	if mode != "embedded" {
		return nil, fmt.Errorf("unknown mode %q", mode)
	}
	var err error
	s.Writer, err = sql.Open(sqliteDriver, sqliteDSN(path))
	if err != nil {
		return nil, err
	}
	s.Writer.SetMaxOpenConns(1)
	s.Writer.SetMaxIdleConns(1)
	if err = s.Writer.PingContext(ctx); err != nil {
		s.Close()
		return nil, err
	}
	s.Reader, err = sql.Open(sqliteDriver, sqliteDSN(path))
	if err != nil {
		s.Close()
		return nil, err
	}
	s.Reader.SetMaxOpenConns(16)
	s.Reader.SetMaxIdleConns(16)
	var fts int
	err = s.Reader.QueryRowContext(ctx, "SELECT count(*) FROM search_doc WHERE search_doc MATCH 'token'").Scan(&fts)
	if err != nil {
		s.Close()
		return nil, fmt.Errorf("FTS5 unavailable: %w", err)
	}
	return s, nil
}

func bind(query string) string {
	var out strings.Builder
	i := 0
	for _, c := range query {
		if c == '?' {
			i++
			out.WriteByte('$')
			out.WriteString(strconv.Itoa(i))
		} else {
			out.WriteRune(c)
		}
	}
	return out.String()
}

func (s *Store) IDExpr() string {
	if s.PG != nil {
		return "nextval('ids')"
	}
	return "NULL"
}

func (s *Store) Query(ctx context.Context, query string, args ...any) (Rows, error) {
	if s.PG != nil {
		return s.PG.Query(ctx, bind(query), args...)
	}
	s.mu.Lock()
	stmt := s.stmts[query]
	if stmt == nil {
		var err error
		stmt, err = s.Reader.PrepareContext(ctx, query)
		if err != nil {
			s.mu.Unlock()
			return nil, err
		}
		s.stmts[query] = stmt
	}
	s.mu.Unlock()
	r, err := stmt.QueryContext(ctx, args...)
	if err != nil {
		return nil, err
	}
	return sqlRows{r}, nil
}

func (s *Store) Exec(ctx context.Context, query string, args ...any) (int64, error) {
	if s.PG != nil {
		tag, err := s.PG.Exec(ctx, bind(query), args...)
		return tag.RowsAffected(), err
	}
	r, err := s.Writer.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, err
	}
	return r.RowsAffected()
}

func (s *Store) Begin(ctx context.Context) (Transaction, error) {
	if s.PG != nil {
		tx, err := s.PG.Begin(ctx)
		if err != nil {
			return nil, err
		}
		return &pgTx{tx}, nil
	}
	tx, err := s.Writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	return &sqliteTx{Tx: tx}, nil
}

func (s *Store) Close() {
	if s == nil {
		return
	}
	for _, stmt := range s.stmts {
		_ = stmt.Close()
	}
	if s.Reader != nil {
		_ = s.Reader.Close()
	}
	if s.Writer != nil {
		_ = s.Writer.Close()
	}
	if s.PG != nil {
		s.PG.Close()
	}
}

type sqliteTx struct {
	*sql.Tx
	stmts map[string]*sql.Stmt
}

func (t *sqliteTx) prepare(ctx context.Context, q string) (*sql.Stmt, error) {
	if t.stmts == nil {
		t.stmts = make(map[string]*sql.Stmt)
	}
	if stmt := t.stmts[q]; stmt != nil {
		return stmt, nil
	}
	stmt, err := t.Tx.PrepareContext(ctx, q)
	if err != nil {
		return nil, err
	}
	t.stmts[q] = stmt
	return stmt, nil
}

func (t *sqliteTx) Query(ctx context.Context, q string, args ...any) (Rows, error) {
	stmt, err := t.prepare(ctx, q)
	if err != nil {
		return nil, err
	}
	r, err := stmt.QueryContext(ctx, args...)
	if err != nil {
		return nil, err
	}
	return sqlRows{r}, nil
}
func (t *sqliteTx) Exec(ctx context.Context, q string, args ...any) (int64, error) {
	stmt, err := t.prepare(ctx, q)
	if err != nil {
		return 0, err
	}
	r, err := stmt.ExecContext(ctx, args...)
	if err != nil {
		return 0, err
	}
	return r.RowsAffected()
}
func (t *sqliteTx) Commit(context.Context) error   { return t.Tx.Commit() }
func (t *sqliteTx) Rollback(context.Context) error { return t.Tx.Rollback() }

var resultCols = []string{"id", "project", "test", "seq", "ord", "batch", "target", "outcome", "basis", "basis_case", "basis_version", "duration_ms", "signature", "message"}

const resultSQL = "INSERT INTO result (id,project,test,seq,ord,batch,target,outcome,basis,basis_case,basis_version,duration_ms,signature,message) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"

func (t *sqliteTx) InsertResults(ctx context.Context, rows [][]any) (int64, error) {
	stmt, err := t.prepare(ctx, resultSQL)
	if err != nil {
		return 0, err
	}
	var count int64
	for _, row := range rows {
		r, err := stmt.ExecContext(ctx, row...)
		if err != nil {
			return count, err
		}
		n, err := r.RowsAffected()
		if err != nil {
			return count, err
		}
		count += n
	}
	return count, nil
}

type pgTx struct{ pgx.Tx }

func (t *pgTx) Query(ctx context.Context, q string, args ...any) (Rows, error) {
	return t.Tx.Query(ctx, bind(q), args...)
}
func (t *pgTx) Exec(ctx context.Context, q string, args ...any) (int64, error) {
	tag, err := t.Tx.Exec(ctx, bind(q), args...)
	return tag.RowsAffected(), err
}
func (t *pgTx) InsertResults(ctx context.Context, rows [][]any) (int64, error) {
	ids, err := t.Query(ctx, "SELECT nextval('ids') FROM generate_series(1, ?)", len(rows))
	if err != nil {
		return 0, err
	}
	i := 0
	for ids.Next() {
		var id int64
		if err = ids.Scan(&id); err != nil {
			ids.Close()
			return 0, err
		}
		rows[i][0] = id
		i++
	}
	err = ids.Err()
	ids.Close()
	if err != nil {
		return 0, err
	}
	if i != len(rows) {
		return 0, errors.New("result ID allocation mismatch")
	}
	return t.Tx.CopyFrom(ctx, pgx.Identifier{"result"}, resultCols, pgx.CopyFromRows(rows))
}

func one(ctx context.Context, q Queries, query string, args []any, dest ...any) error {
	rows, err := q.Query(ctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	if !rows.Next() {
		if err = rows.Err(); err != nil {
			return err
		}
		return sql.ErrNoRows
	}
	return rows.Scan(dest...)
}

func placeholders(n int) string { return strings.TrimSuffix(strings.Repeat("?,", n), ",") }

func requireRows(n, want int64, err error) error {
	if err != nil {
		return err
	}
	if n != want {
		return fmt.Errorf("wrote %d rows; expected %d", n, want)
	}
	return nil
}
