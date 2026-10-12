use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_postgres::{
    Client, NoTls, Statement,
    types::{ToSql, Type},
};

pub enum Db {
    Sqlite(rusqlite::Connection),
    Pg {
        client: Client,
        statements: HashMap<String, Statement>,
    },
}
impl Db {
    pub fn sqlite(&self) -> bool {
        matches!(self, Self::Sqlite(_))
    }
    pub fn newid(&self) -> &'static str {
        if self.sqlite() {
            "NULL"
        } else {
            "nextval('ids')"
        }
    }
    async fn statement(&mut self, sql: &str) -> Result<Statement> {
        if let Self::Pg { client, statements } = self {
            if let Some(s) = statements.get(sql) {
                return Ok(s.clone());
            }
            let s = client.prepare(sql).await.with_context(|| sql.to_owned())?;
            statements.insert(sql.to_owned(), s.clone());
            Ok(s)
        } else {
            bail!("PostgreSQL statement requested on SQLite")
        }
    }
    pub async fn batch(&mut self, sql: &str) -> Result<()> {
        match self {
            Self::Sqlite(c) => c.execute_batch(sql).context(sql.to_owned())?,
            Self::Pg { client, .. } => client.batch_execute(sql).await.context(sql.to_owned())?,
        };
        Ok(())
    }
    pub async fn q(&mut self, sql: &str, args: &[Value]) -> Result<Vec<Value>> {
        if let Self::Sqlite(c) = self {
            let mut s = c.prepare_cached(sql).with_context(|| sql.to_owned())?;
            let names = s
                .column_names()
                .into_iter()
                .map(str::to_owned)
                .collect::<Vec<_>>();
            let values = args.iter().map(sqlite_arg).collect::<Vec<_>>();
            let mut rows = s
                .query(rusqlite::params_from_iter(values.iter()))
                .with_context(|| sql.to_owned())?;
            let mut out = Vec::new();
            while let Some(row) = rows.next()? {
                let mut o = serde_json::Map::new();
                for (i, name) in names.iter().enumerate() {
                    use rusqlite::types::ValueRef;
                    let value = match row.get_ref(i)? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(x) => json!(x),
                        ValueRef::Real(x) => json!(x),
                        ValueRef::Text(x) => json!(std::str::from_utf8(x)?),
                        ValueRef::Blob(_) => bail!("Unexpected blob column"),
                    };
                    o.insert(name.clone(), value);
                }
                out.push(Value::Object(o));
            }
            return Ok(out);
        }
        let statement = self.statement(sql).await?;
        let params = pg_args(&statement, args)?;
        let refs = params
            .iter()
            .map(|p| &**p as &(dyn ToSql + Sync))
            .collect::<Vec<_>>();
        let Self::Pg { client, .. } = self else {
            unreachable!()
        };
        let rows = client
            .query(&statement, &refs)
            .await
            .with_context(|| sql.to_owned())?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let mut o = serde_json::Map::new();
            for (i, col) in row.columns().iter().enumerate() {
                let value = match *col.type_() {
                    Type::INT8 => json!(row.try_get::<_, Option<i64>>(i)?),
                    Type::INT4 => json!(row.try_get::<_, Option<i32>>(i)?),
                    Type::INT2 => json!(row.try_get::<_, Option<i16>>(i)?),
                    Type::FLOAT4 => json!(row.try_get::<_, Option<f32>>(i)?),
                    Type::FLOAT8 => json!(row.try_get::<_, Option<f64>>(i)?),
                    Type::BOOL => json!(row.try_get::<_, Option<bool>>(i)?),
                    _ => json!(row.try_get::<_, Option<String>>(i)?),
                };
                o.insert(col.name().to_owned(), value);
            }
            out.push(Value::Object(o));
        }
        Ok(out)
    }
    pub async fn x(&mut self, sql: &str, args: &[Value]) -> Result<u64> {
        if let Self::Sqlite(c) = self {
            let values = args.iter().map(sqlite_arg).collect::<Vec<_>>();
            return Ok(c
                .prepare_cached(sql)
                .context(sql.to_owned())?
                .execute(rusqlite::params_from_iter(values.iter()))
                .context(sql.to_owned())? as u64);
        }
        let statement = self.statement(sql).await?;
        let params = pg_args(&statement, args)?;
        let refs = params
            .iter()
            .map(|p| &**p as &(dyn ToSql + Sync))
            .collect::<Vec<_>>();
        let Self::Pg { client, .. } = self else {
            unreachable!()
        };
        Ok(client
            .execute(&statement, &refs)
            .await
            .context(sql.to_owned())?)
    }
    pub async fn one(&mut self, sql: &str, args: &[Value]) -> Result<Value> {
        self.q(sql, args)
            .await?
            .into_iter()
            .next()
            .context("Expected one row")
    }
    pub async fn count(&mut self, sql: &str, args: &[Value]) -> Result<i64> {
        Ok(self.one(sql, args).await?["n"]
            .as_i64()
            .context("Count is not integer")?)
    }
    pub async fn begin(&mut self) -> Result<()> {
        self.batch(if self.sqlite() {
            "BEGIN IMMEDIATE"
        } else {
            "BEGIN"
        })
        .await
    }
    pub async fn lock_project(&mut self) -> Result<()> {
        if !self.sqlite() {
            self.q("SELECT seq FROM project WHERE id=1 FOR UPDATE", &[])
                .await?;
        }
        Ok(())
    }
    pub fn json_id_set(&self) -> &'static str {
        if self.sqlite() {
            "SELECT CAST(value AS BIGINT) FROM json_each($1)"
        } else {
            "SELECT value::bigint FROM jsonb_array_elements_text($1::text::jsonb)"
        }
    }
    pub async fn search(&mut self, query: &str, area: i64) -> Result<Vec<Value>> {
        let low = 21 + (area - 1) * 24;
        let high = low + 23;
        let mut args = [json!(query), json!(area), json!(low), json!(high)];
        let sql = if self.sqlite() {
            args[0] = json!(
                query
                    .split_whitespace()
                    .map(|s| format!("\"{}\"", s.replace('"', "\"\"")))
                    .collect::<Vec<_>>()
                    .join(" AND ")
            );
            "SELECT k.id,k.ref_no,k.title,k.folder,-bm25(search_doc) AS score,search_doc.text FROM search_doc JOIN kase k ON k.id=search_doc.rowid WHERE search_doc MATCH $1 AND search_doc.project=1 AND ($2=0 OR search_doc.folder BETWEEN $3 AND $4) ORDER BY score DESC LIMIT 50"
        } else {
            "WITH hits AS MATERIALIZED (SELECT case_id,text,ts_rank(tsv,plainto_tsquery('simple',$1)) AS score FROM search_doc WHERE project=1 AND tsv @@ plainto_tsquery('simple',$1) AND ($2::bigint=0 OR folder BETWEEN $3 AND $4) ORDER BY score DESC LIMIT 50) SELECT k.id,k.ref_no,k.title,k.folder,hits.score,hits.text FROM hits JOIN kase k ON k.id=hits.case_id ORDER BY hits.score DESC"
        };
        self.q(sql, &args).await
    }
    pub async fn replace_search(&mut self, id: i64, text: &str, folder: i64) -> Result<()> {
        if self.sqlite() {
            self.x("DELETE FROM search_doc WHERE rowid=$1", &[json!(id)])
                .await?;
            self.x(
                "INSERT INTO search_doc(rowid,text,project,folder) VALUES($1,$2,1,$3)",
                &[json!(id), json!(text), json!(folder)],
            )
            .await?;
        } else {
            self.x(
                "UPDATE search_doc SET text=$1,folder=$2 WHERE case_id=$3",
                &[json!(text), json!(folder), json!(id)],
            )
            .await?;
        }
        Ok(())
    }
    pub async fn audit_search(&mut self, id: Value) -> Result<Vec<Value>> {
        let sql = if self.sqlite() {
            "SELECT rowid AS case_id,text,project,folder FROM search_doc WHERE rowid=$1"
        } else {
            "SELECT case_id,text,project,folder FROM search_doc WHERE case_id=$1"
        };
        self.q(sql, &[id]).await
    }
    pub async fn stage(&mut self, rows: &str) -> Result<()> {
        self.batch("CREATE TEMP TABLE IF NOT EXISTS stage (ord BIGINT, key TEXT, outcome TEXT, duration_ms BIGINT, message TEXT, sig_hash TEXT); DELETE FROM stage;").await?;
        let sql = if self.sqlite() {
            "INSERT INTO stage SELECT CAST(j.key AS INTEGER),json_extract(j.value,'$.key'),json_extract(j.value,'$.outcome'),json_extract(j.value,'$.durationMs'),json_extract(j.value,'$.message'),json_extract(j.value,'$.sig_hash') FROM json_each($1) j"
        } else {
            "INSERT INTO stage SELECT (j.ord-1)::bigint,j.value->>'key',j.value->>'outcome',(j.value->>'durationMs')::bigint,j.value->>'message',j.value->>'sig_hash' FROM jsonb_array_elements($1::text::jsonb) WITH ORDINALITY AS j(value,ord)"
        };
        self.x(sql, &[json!(rows)]).await?;
        Ok(())
    }
}
fn sqlite_arg(v: &Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as S;
    match v {
        Value::Null => S::Null,
        Value::Number(n) => n
            .as_i64()
            .map(S::Integer)
            .unwrap_or_else(|| S::Real(n.as_f64().unwrap())),
        Value::Bool(x) => S::Integer(*x as i64),
        Value::String(x) => S::Text(x.clone()),
        _ => S::Text(v.to_string()),
    }
}
fn pg_args(s: &Statement, args: &[Value]) -> Result<Vec<Box<dyn ToSql + Sync + Send>>> {
    if s.params().len() != args.len() {
        bail!("Parameter length mismatch")
    }
    let mut out: Vec<Box<dyn ToSql + Sync + Send>> = Vec::new();
    for (ty, v) in s.params().iter().zip(args) {
        out.push(match *ty {
            Type::INT8 => Box::new(v.as_i64()),
            Type::INT4 => Box::new(v.as_i64().map(|x| x as i32)),
            Type::INT2 => Box::new(v.as_i64().map(|x| x as i16)),
            Type::FLOAT8 => Box::new(v.as_f64()),
            Type::FLOAT4 => Box::new(v.as_f64().map(|x| x as f32)),
            Type::BOOL => Box::new(v.as_bool()),
            _ => Box::new(v.as_str().map(str::to_owned)),
        });
    }
    Ok(out)
}

pub struct Pool {
    conns: Mutex<Vec<Db>>,
    sem: Arc<Semaphore>,
}
pub struct Lease {
    pub db: Option<Db>,
    pool: Arc<Pool>,
    _permit: OwnedSemaphorePermit,
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(c) = self.db.take() {
            self.pool.conns.lock().unwrap().push(c);
        }
    }
}
impl Pool {
    pub async fn open(mode: &str, path: &str, n: usize) -> Result<Arc<Self>> {
        let mut conns = Vec::new();
        for _ in 0..n {
            let db = if mode == "embedded" {
                let c = rusqlite::Connection::open(path)?;
                c.busy_timeout(Duration::from_secs(15))?;
                c.set_prepared_statement_cache_capacity(128);
                c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA foreign_keys=ON;")?;
                if n == 1 {
                    c.execute_batch("PRAGMA cache_size=-65536")?;
                }
                Db::Sqlite(c)
            } else {
                let (client, connection) = tokio_postgres::connect(path, NoTls).await?;
                tokio::spawn(async move {
                    if let Err(e) = connection.await {
                        eprintln!("postgres connection: {e}");
                    }
                });
                client.batch_execute("SET synchronous_commit=on").await?;
                Db::Pg {
                    client,
                    statements: HashMap::new(),
                }
            };
            conns.push(db);
        }
        Ok(Arc::new(Self {
            conns: Mutex::new(conns),
            sem: Arc::new(Semaphore::new(n)),
        }))
    }
    pub async fn get(self: &Arc<Self>) -> Result<Lease> {
        let permit = self.sem.clone().acquire_owned().await?;
        let db = self
            .conns
            .lock()
            .unwrap()
            .pop()
            .context("Pool has no connection")?;
        Ok(Lease {
            db: Some(db),
            pool: self.clone(),
            _permit: permit,
        })
    }
}
