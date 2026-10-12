\timing on
EXPLAIN (ANALYZE, BUFFERS)
SELECT k.id,k.ref_no,k.title,k.folder,ts_rank(d.tsv,q.query) AS score
FROM search_doc d JOIN kase k ON k.id=d.case_id
CROSS JOIN plainto_tsquery('simple','confirmation') q(query)
WHERE d.project=1 AND d.tsv @@ q.query
ORDER BY score DESC,k.id LIMIT 50;

EXPLAIN (ANALYZE, BUFFERS)
WITH hits AS MATERIALIZED (
  SELECT d.case_id,ts_rank(d.tsv,q.query) AS score
  FROM search_doc d CROSS JOIN plainto_tsquery('simple','confirmation') q(query)
  WHERE d.project=1 AND d.tsv @@ q.query
  ORDER BY score DESC,d.case_id LIMIT 50
)
SELECT k.id,k.ref_no,k.title,k.folder,h.score
FROM hits h JOIN kase k ON k.id=h.case_id
ORDER BY h.score DESC,k.id;

EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*) FROM question WHERE project=1 AND state='open';
