use crate::db::{Db, Pool};
use anyhow::{Context, Result, bail, ensure};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Arc, time::Instant};

#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GetIn {
    pub ref_no: i64,
}
#[derive(Serialize, Deserialize, JsonSchema)]
pub struct GetOut {
    pub case: CaseRow,
    pub body: CaseBody,
}
#[derive(Serialize, Deserialize, JsonSchema)]
pub struct CaseRow {
    pub id: i64,
    pub project: i64,
    pub ref_no: i64,
    pub folder: i64,
    pub rank: i64,
    pub title: String,
    pub head_no: i64,
    pub head_hash: String,
    pub state: String,
    pub rev: i64,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Step {
    pub id: String,
    pub action: String,
    pub expected: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CaseBody {
    pub title: String,
    pub pre: String,
    pub steps: Vec<Step>,
    pub methods: Vec<Value>,
    pub intent: Value,
    pub fields: Value,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProposeIn {
    pub cmd: String,
    pub ref_no: i64,
    pub body: CaseBody,
    pub base_no: Option<i64>,
}
#[derive(Serialize, Deserialize, JsonSchema)]
pub struct ProposeOut {
    pub case_id: i64,
    pub no: i64,
    pub seq: i64,
    pub hash: String,
    pub question: i64,
    pub decision: i64,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ResultIn {
    pub key: String,
    pub outcome: String,
    #[serde(rename = "durationMs")]
    pub duration_ms: i64,
    pub message: Option<String>,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReportIn {
    pub batch_key: String,
    pub commit_sha: String,
    pub results: Vec<ResultIn>,
}
#[derive(Serialize, Deserialize, JsonSchema)]
pub struct ReportOut {
    pub batch_id: i64,
    pub seq: i64,
    pub results: i64,
    pub new_tests: i64,
    pub new_signatures: i64,
    pub questions: i64,
    pub replay: bool,
}

#[derive(Clone)]
pub struct Store {
    read: Arc<Pool>,
    write: Arc<Pool>,
    sqlite: bool,
}
impl Store {
    pub async fn open(mode: &str, path: &str) -> Result<Self> {
        ensure!(
            mode == "embedded" || mode == "server",
            "mode must be embedded or server"
        );
        let sqlite = mode == "embedded";
        let read = Pool::open(mode, path, if sqlite { 8 } else { 16 }).await?;
        let write = Pool::open(mode, path, if sqlite { 1 } else { 2 }).await?;
        Ok(Self {
            read,
            write,
            sqlite,
        })
    }
    pub async fn call(&self, op: &str, input: Value) -> Result<(Value, f64)> {
        let t = Instant::now();
        let write = crate::registry::operations()
            .iter()
            .find(|s| s.name == op)
            .map(|s| s.write)
            .unwrap_or(false);
        let mut lease = if write {
            self.write.get().await?
        } else {
            self.read.get().await?
        };
        let name = op.to_owned();
        let out = if self.sqlite {
            tokio::task::spawn_blocking(move || {
                let runtime = tokio::runtime::Handle::current();
                runtime.block_on(invoke(lease.db.as_mut().unwrap(), &name, input))
            })
            .await??
        } else if write {
            tokio::spawn(async move { invoke(lease.db.as_mut().unwrap(), &name, input).await })
                .await??
        } else {
            invoke(lease.db.as_mut().unwrap(), &name, input).await?
        };
        Ok((out, t.elapsed().as_secs_f64() * 1000.0))
    }
}
pub fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
fn num(v: &Value, key: &str) -> Result<i64> {
    v[key]
        .as_i64()
        .with_context(|| format!("Missing integer {key}"))
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .with_context(|| format!("Missing string {key}"))
}
async fn invoke(db: &mut Db, op: &str, input: Value) -> Result<Value> {
    if let Some(spec) = crate::registry::operations()
        .into_iter()
        .find(|s| s.name == op)
    {
        if spec.write {
            db.begin().await?;
            let result = async {
                db.lock_project().await?;
                crate::registry::dispatch(db, op, input).await
            }
            .await;
            return finish(db, result).await;
        }
        return crate::registry::dispatch(db, op, input).await;
    }
    match op {
        "w2" => folder(db, &input).await,
        "w3" => search(db, &input).await,
        "w6" => Ok(
            json!({"items":db.q("SELECT * FROM result WHERE project=1 AND test=$1 ORDER BY seq DESC,ord DESC LIMIT 20",&[input["test"].clone()]).await?}),
        ),
        "w7" => {
            let row = db
                .one(
                    "SELECT * FROM run WHERE project=1 AND commit_sha=$1",
                    &[input["commit_sha"].clone()],
                )
                .await?;
            Ok(json!({"tally":serde_json::from_str::<Value>(text(&row,"tally")?)?,"run":row}))
        }
        "w8" => queue(db).await,
        "audit" => audit(db, &input).await,
        _ => bail!("Unknown operation {op}"),
    }
}
async fn finish(db: &mut Db, result: Result<Value>) -> Result<Value> {
    match result {
        Ok(v) => {
            let mut timer = Instant::now();
            db.batch("COMMIT").await?;
            profile("commit", &mut timer);
            Ok(v)
        }
        Err(e) => {
            db.batch("ROLLBACK").await?;
            Err(e)
        }
    }
}
pub(crate) async fn get(db: &mut Db, x: GetIn) -> Result<Value> {
    let mut row=db.one("SELECT k.*,v.body FROM kase k JOIN version v ON v.case_id=k.id AND v.no=k.head_no WHERE k.project=1 AND k.ref_no=$1",&[json!(x.ref_no)]).await?;
    let body = serde_json::from_str::<CaseBody>(text(&row, "body")?)?;
    row.as_object_mut().unwrap().remove("body");
    Ok(serde_json::to_value(GetOut {
        case: serde_json::from_value(row)?,
        body,
    })?)
}
async fn open_count(db: &mut Db) -> Result<i64> {
    db.count(
        "SELECT COUNT(*) AS n FROM question WHERE project=1 AND state='open'",
        &[],
    )
    .await
}
async fn folder(db: &mut Db, x: &Value) -> Result<Value> {
    let mut items = db
        .q(
            "SELECT * FROM kase WHERE project=1 AND folder=$1 AND rank>$2 ORDER BY rank LIMIT 50",
            &[json!(num(x, "folder")?), json!(num(x, "cursor")?)],
        )
        .await?;
    let ids = items.iter().map(|r| r["id"].clone()).collect::<Vec<_>>();
    let set = db.json_id_set();
    let sql = format!(
        "SELECT t.case_id,t.id,(SELECT r.outcome FROM result r WHERE r.project=1 AND r.test=t.id ORDER BY r.seq DESC,r.ord DESC LIMIT 1) AS outcome FROM test t WHERE t.project=1 AND t.case_id IN ({set})"
    );
    let tests = db.q(&sql, &[json!(serde_json::to_string(&ids)?)]).await?;
    let count = open_count(db).await?;
    for item in &mut items {
        let matches = tests
            .iter()
            .filter(|t| t["case_id"] == item["id"])
            .collect::<Vec<_>>();
        item["test_count"] = json!(matches.len());
        item["last_outcomes"] = json!(
            matches
                .iter()
                .map(|t| t["outcome"].clone())
                .collect::<Vec<_>>()
        );
    }
    Ok(json!({"items":items,"open_questions":count}))
}
async fn search(db: &mut Db, x: &Value) -> Result<Value> {
    let query = text(x, "query")?;
    let area = x["area"].as_i64().unwrap_or(0);
    ensure!((0..=20).contains(&area), "area out of range");
    Ok(json!({"items":db.search(query,area).await?}))
}
async fn queue(db: &mut Db) -> Result<Value> {
    let mut items = db
        .q(
            "SELECT * FROM question WHERE project=1 AND state='open' ORDER BY owner,rank LIMIT 50",
            &[],
        )
        .await?;
    for row in &mut items {
        row["evidence"] = serde_json::from_str(text(row, "evidence")?)?;
    }
    Ok(json!({"items":items,"open_questions":open_count(db).await?}))
}
async fn bump(db: &mut Db) -> Result<i64> {
    Ok(num(
        &db.one("UPDATE project SET seq=seq+1 WHERE id=1 RETURNING seq", &[])
            .await?,
        "seq",
    )?)
}
pub(crate) async fn propose(db: &mut Db, x: ProposeIn) -> Result<Value> {
    ensure!(!x.cmd.is_empty(), "empty command id");
    let existing = db
        .q("SELECT outcome FROM command WHERE id=$1", &[json!(x.cmd)])
        .await?;
    if let Some(row) = existing.first() {
        return Ok(serde_json::from_str(text(row, "outcome")?)?);
    }
    // Claim project sequence first: all mutation commits serialize on this row in PostgreSQL.
    db.x(
        "INSERT INTO command (id,project,op,actor,seq,outcome) VALUES ($1,1,'propose',1,0,'{}')",
        &[json!(x.cmd)],
    )
    .await?;
    let seq = bump(db).await?;
    let row = db
        .one(
            "SELECT id,head_no,folder FROM kase WHERE project=1 AND ref_no=$1",
            &[json!(x.ref_no)],
        )
        .await?;
    let id = num(&row, "id")?;
    let parent = num(&row, "head_no")?;
    let no = parent + 1;
    if let Some(base) = x.base_no {
        ensure!(
            base == parent,
            "conflict: base version {base}, head {parent}"
        );
    }
    let body = serde_json::to_string(&x.body)?;
    let digest = hash(&body);
    db.x(
        "UPDATE command SET seq=$1 WHERE id=$2",
        &[json!(seq), json!(x.cmd)],
    )
    .await?;
    let evidence = json!({"case":id,"version":no,"hash":digest}).to_string();
    let evidence_hash = hash(&evidence);
    let qsql = format!(
        "INSERT INTO question(id,project,ref_no,kind,fingerprint,epoch,state,owner,rank,evidence,evidence_hash,rev) VALUES ({},1,$1,'adopt',$2,0,'decided',0,$1,$3,$4,$1) RETURNING id",
        db.newid()
    );
    let question = num(
        &db.one(
            &qsql,
            &[
                json!(seq),
                json!(format!("adopt:{}", x.cmd)),
                json!(evidence),
                json!(evidence_hash),
            ],
        )
        .await?,
        "id",
    )?;
    let dsql = format!(
        "INSERT INTO decision(id,project,question,kind,answer,basis,seq) VALUES ({},1,$1,'adopt','accept',$2,$3) RETURNING id",
        db.newid()
    );
    let decision = num(
        &db.one(&dsql, &[json!(question), json!(evidence_hash), json!(seq)])
            .await?,
        "id",
    )?;
    db.x("INSERT INTO version(case_id,no,parent,body,hash,claim_hash,seq) VALUES($1,$2,$3,$4,$5,$5,$6)",&[json!(id),json!(no),json!(parent),json!(body),json!(digest),json!(seq)]).await?;
    ensure!(
        db.x(
            "UPDATE kase SET head_no=$1,title=$2,head_hash=$3,rev=$4 WHERE id=$5",
            &[
                json!(no),
                json!(x.body.title),
                json!(digest),
                json!(seq),
                json!(id)
            ]
        )
        .await?
            == 1,
        "head update rowcount"
    );
    let search_text = std::iter::once(x.body.title.clone())
        .chain(std::iter::once(x.body.pre.clone()))
        .chain(
            x.body
                .steps
                .iter()
                .flat_map(|s| [s.action.clone(), s.expected.clone().unwrap_or_default()]),
        )
        .collect::<Vec<_>>()
        .join(" ");
    db.replace_search(id, &search_text, num(&row, "folder")?)
        .await?;
    let out = serde_json::to_value(ProposeOut {
        case_id: id,
        no,
        seq,
        hash: digest,
        question,
        decision,
    })?;
    db.x(
        "UPDATE command SET outcome=$1 WHERE id=$2",
        &[json!(out.to_string()), json!(x.cmd)],
    )
    .await?;
    Ok(out)
}
fn profile(phase: &str, t: &mut Instant) {
    if std::env::var_os("CB_PROFILE").is_some() {
        eprintln!(
            "profile {} {:.6}ms",
            phase,
            t.elapsed().as_secs_f64() * 1000.0
        );
    }
    *t = Instant::now();
}
pub(crate) async fn report(db: &mut Db, x: ReportIn) -> Result<Value> {
    let mut timer = Instant::now();
    ensure!(
        x.results.iter().all(|r| !r.key.is_empty()
            && (r.outcome == "pass" || r.outcome == "fail")
            && r.duration_ms >= 0
            && (r.outcome != "fail" || r.message.is_some())),
        "invalid report result"
    );
    ensure!(!x.batch_key.is_empty(), "empty batch key");
    let existing = db
        .q(
            "SELECT id,seq FROM batch WHERE project=1 AND key=$1",
            &[json!(x.batch_key)],
        )
        .await?;
    if let Some(row) = existing.first() {
        return Ok(serde_json::to_value(ReportOut {
            batch_id: num(row, "id")?,
            seq: num(row, "seq")?,
            results: 0,
            new_tests: 0,
            new_signatures: 0,
            questions: 0,
            replay: true,
        })?);
    }
    let seq = bump(db).await?;
    let known = db
        .q("SELECT hash,sample FROM signature WHERE project=1", &[])
        .await?;
    let mut hashes = HashMap::<String, String>::new();
    for row in &known {
        hashes.insert(
            text(row, "sample")?
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "),
            text(row, "hash")?.to_owned(),
        );
    }
    let mut rows = Vec::with_capacity(x.results.len());
    for r in &x.results {
        let normal = if r.outcome == "fail" {
            r.message
                .as_ref()
                .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
        } else {
            None
        };
        let digest = normal
            .as_ref()
            .map(|s| hashes.get(s).cloned().unwrap_or_else(|| hash(s)));
        rows.push(json!({"key":r.key,"outcome":r.outcome,"durationMs":r.duration_ms,"message":r.message,"sig_hash":digest}));
    }
    db.stage(&serde_json::to_string(&rows)?).await?;
    profile("normalize_and_stage", &mut timer);
    let testsql = format!(
        "INSERT INTO test(id,project,key,case_id,file) SELECT {},1,s.key,NULL,NULL FROM stage s WHERE NOT EXISTS (SELECT 1 FROM test t WHERE t.project=1 AND t.key=s.key) ON CONFLICT(project,key) DO NOTHING",
        db.newid()
    );
    let new_tests = db.x(&testsql, &[]).await?;
    let sigsql = format!(
        "INSERT INTO signature(id,project,hash,class,sample) SELECT {},1,s.sig_hash,'assertion',s.message FROM (SELECT sig_hash,MIN(message) AS message FROM stage WHERE sig_hash IS NOT NULL GROUP BY sig_hash) s WHERE NOT EXISTS (SELECT 1 FROM signature g WHERE g.project=1 AND g.hash=s.sig_hash) ON CONFLICT(project,hash) DO NOTHING",
        db.newid()
    );
    let new_signatures = db.x(&sigsql, &[]).await?;
    profile("test_signature_upserts", &mut timer);
    let targetsql = format!(
        "INSERT INTO target(id,project,commit_sha,env) VALUES({},1,$1,'arena') ON CONFLICT(project,commit_sha,env) DO NOTHING",
        db.newid()
    );
    db.x(&targetsql, &[json!(x.commit_sha)]).await?;
    let target = num(
        &db.one(
            "SELECT id FROM target WHERE project=1 AND commit_sha=$1 AND env='arena'",
            &[json!(x.commit_sha)],
        )
        .await?,
        "id",
    )?;
    let batchsql = format!(
        "INSERT INTO batch(id,project,key,target,job,attempt,state,seq) VALUES({},1,$1,$2,'arena',1,'applied',$3) RETURNING id",
        db.newid()
    );
    let batch = num(
        &db.one(&batchsql, &[json!(x.batch_key), json!(target), json!(seq)])
            .await?,
        "id",
    )?;
    profile("target_batch", &mut timer);
    let resultsql = format!(
        "INSERT INTO result(id,project,test,seq,ord,batch,target,outcome,basis,basis_case,basis_version,duration_ms,signature,message) SELECT {},1,t.id,$1,s.ord,$2,$3,s.outcome,CASE WHEN t.case_id IS NULL THEN 'unresolved' ELSE 'assumed' END,t.case_id,k.head_no,s.duration_ms,g.id,s.message FROM stage s JOIN test t ON t.project=1 AND t.key=s.key LEFT JOIN kase k ON k.id=t.case_id LEFT JOIN signature g ON g.project=1 AND g.hash=s.sig_hash",
        db.newid()
    );
    let written = db
        .x(&resultsql, &[json!(seq), json!(batch), json!(target)])
        .await?;
    ensure!(written == x.results.len() as u64, "wrong result rowcount");
    profile("result_insert", &mut timer);
    let sigrows=db.q("SELECT g.id,g.hash,g.sample,s.n FROM (SELECT sig_hash,COUNT(*) AS n FROM stage WHERE sig_hash IS NOT NULL GROUP BY sig_hash) s JOIN signature g ON g.project=1 AND g.hash=s.sig_hash",&[]).await?;
    let mut questions = 0;
    for (i, sig) in sigrows.iter().enumerate() {
        let fp = format!("signature:{}", text(sig, "hash")?);
        if db.count("SELECT COUNT(*) AS n FROM question WHERE project=1 AND fingerprint=$1 AND state='open'",&[json!(fp)]).await?!=0 {continue;}
        let evidence =
            json!({"signature":sig["id"],"count":sig["n"],"sample":sig["sample"],"batch":batch})
                .to_string();
        let qsql = format!(
            "INSERT INTO question(id,project,ref_no,kind,fingerprint,epoch,state,owner,rank,evidence,evidence_hash,rev) VALUES({},1,$1,'failure',$2,0,'open',0,$1,$3,$4,$5)",
            db.newid()
        );
        db.x(
            &qsql,
            &[
                json!(seq * 100 + i as i64),
                json!(fp),
                json!(evidence),
                json!(hash(&evidence)),
                json!(seq),
            ],
        )
        .await?;
        questions += 1;
    }
    let failed = x.results.iter().filter(|r| r.outcome == "fail").count();
    let tally = json!({"pass":written as usize-failed,"fail":failed});
    let runsql = format!(
        "INSERT INTO run(id,project,commit_sha,verdict,tally,outstanding,next_expiry,rev) VALUES({},1,$1,$2,$3,0,NULL,$4) ON CONFLICT(project,commit_sha) DO UPDATE SET verdict=excluded.verdict,tally=excluded.tally,rev=excluded.rev",
        db.newid()
    );
    db.x(
        &runsql,
        &[
            json!(x.commit_sha),
            json!(if failed > 0 { "blocked" } else { "passed" }),
            json!(tally.to_string()),
            json!(seq),
        ],
    )
    .await?;
    profile("questions_run", &mut timer);
    Ok(serde_json::to_value(ReportOut {
        batch_id: batch,
        seq,
        results: written as i64,
        new_tests: new_tests as i64,
        new_signatures: new_signatures as i64,
        questions,
        replay: false,
    })?)
}
async fn audit(db: &mut Db, x: &Value) -> Result<Value> {
    match text(x, "kind")? {
        "snapshot" => {
            let mut out = serde_json::Map::new();
            out.insert(
                "seq".into(),
                db.one("SELECT seq FROM project WHERE id=1", &[]).await?["seq"].clone(),
            );
            for (name, table) in [
                ("commands", "command"),
                ("versions", "version"),
                ("questions", "question"),
                ("decisions", "decision"),
                ("results", "result"),
                ("tests", "test"),
                ("signatures", "signature"),
                ("batches", "batch"),
            ] {
                out.insert(
                    name.into(),
                    json!(
                        db.count(&format!("SELECT COUNT(*) AS n FROM {table}"), &[])
                            .await?
                    ),
                );
            }
            Ok(Value::Object(out))
        }
        "save" => {
            let cmds = db
                .q("SELECT * FROM command WHERE id=$1", &[x["cmd"].clone()])
                .await?;
            let row = cmds.first().context("No command")?;
            let out: Value = serde_json::from_str(text(row, "outcome")?)?;
            Ok(
                json!({"command":cmds,"version":db.q("SELECT * FROM version WHERE case_id=$1 AND no=$2",&[out["case_id"].clone(),out["no"].clone()]).await?,"question":db.q("SELECT * FROM question WHERE id=$1",&[out["question"].clone()]).await?,"decision":db.q("SELECT * FROM decision WHERE id=$1",&[out["decision"].clone()]).await?,"search":db.audit_search(out["case_id"].clone()).await?}),
            )
        }
        "report" => {
            let batch = db
                .one(
                    "SELECT * FROM batch WHERE project=1 AND key=$1",
                    &[x["batch_key"].clone()],
                )
                .await?;
            let id = batch["id"].clone();
            let grouped=db.q("SELECT outcome,basis,COUNT(*) AS n FROM result WHERE project=1 AND batch=$1 GROUP BY outcome,basis",&[id.clone()]).await?;
            let sum = |key: &str, val: &str| {
                grouped
                    .iter()
                    .filter(|r| r[key] == val)
                    .map(|r| r["n"].as_i64().unwrap())
                    .sum::<i64>()
            };
            let counts=db.one("SELECT COUNT(*) AS n,COUNT(DISTINCT signature) AS signatures FROM result WHERE project=1 AND batch=$1",&[id.clone()]).await?;
            let bad=db.count("SELECT COUNT(*) AS n FROM result r JOIN test t ON t.id=r.test LEFT JOIN version v ON v.case_id=r.basis_case AND v.no=r.basis_version WHERE r.project=1 AND r.batch=$1 AND ((t.case_id IS NOT NULL AND (r.basis<>'assumed' OR r.basis_case<>t.case_id OR v.no IS NULL)) OR (t.case_id IS NULL AND (r.basis<>'unresolved' OR r.basis_case IS NOT NULL OR r.basis_version IS NOT NULL)))",&[id.clone()]).await?;
            let duplicates=db.count("SELECT COUNT(*) AS n FROM (SELECT q.fingerprint FROM question q WHERE q.project=1 AND q.state='open' AND q.fingerprint IN (SELECT 'signature:'||s.hash FROM signature s JOIN result r ON r.signature=s.id WHERE r.project=1 AND r.batch=$1) GROUP BY q.fingerprint HAVING COUNT(*)>1) d",&[id.clone()]).await?;
            let run=db.one("SELECT r.tally FROM run r JOIN target t ON t.project=r.project AND t.commit_sha=r.commit_sha WHERE t.id=$1",&[batch["target"].clone()]).await?;
            Ok(
                json!({"batch_id":id,"results":counts["n"],"failures":sum("outcome","fail"),"signatures":counts["signatures"],"assumed":sum("basis","assumed"),"unresolved":sum("basis","unresolved"),"bad_basis":bad,"open_duplicates":duplicates,"run_tally":serde_json::from_str::<Value>(text(&run,"tally")?)?}),
            )
        }
        _ => bail!("unknown audit kind"),
    }
}

pub fn parse_junit(xml: &str) -> Result<Vec<ResultIn>> {
    use quick_xml::{Reader, events::Event};
    let mut reader = Reader::from_str(xml);
    let mut current: Option<ResultIn> = None;
    let mut failure = false;
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut roots = 0usize;
    let mut suite_seen = false;
    loop {
        let event = reader.read_event()?;
        match &event {
            Event::Start(e) | Event::Empty(e) => {
                let name = e.name();
                if depth == 0 {
                    roots += 1;
                    ensure!(
                        roots == 1
                            && (name.as_ref() == b"testsuites" || name.as_ref() == b"testsuite"),
                        "expected one JUnit suite root"
                    );
                }
                if name.as_ref() == b"testsuite" {
                    suite_seen = true;
                }
                if matches!(&event, Event::Start(_)) {
                    depth += 1;
                }
            }
            Event::End(_) => {
                ensure!(depth > 0, "unexpected end tag");
                depth -= 1;
            }
            Event::Text(e) if depth == 0 => {
                ensure!(e.decode()?.trim().is_empty(), "text outside JUnit root")
            }
            Event::CData(_) | Event::GeneralRef(_) if depth == 0 => {
                bail!("content outside JUnit root")
            }
            Event::Eof => ensure!(
                depth == 0 && roots == 1 && suite_seen,
                "truncated or empty JUnit document"
            ),
            _ => {}
        }
        match event {
            Event::Start(e) | Event::Empty(e) if e.name().as_ref() == b"testcase" => {
                let mut name = String::new();
                let mut class = String::new();
                let mut duration = 0;
                for attr in e.attributes() {
                    let attr = attr?;
                    let value = attr
                        .decode_and_unescape_value(reader.decoder())?
                        .into_owned();
                    match attr.key.as_ref() {
                        b"name" => name = value,
                        b"classname" => class = value,
                        b"time" => duration = (value.parse::<f64>()? * 1000.0) as i64,
                        _ => {}
                    }
                }
                ensure!(!name.is_empty(), "testcase missing name");
                if let Some(c) = current.take() {
                    out.push(c);
                }
                current = Some(ResultIn {
                    key: format!("{class}::{name}"),
                    outcome: "pass".into(),
                    duration_ms: duration,
                    message: None,
                });
                failure = false;
            }
            Event::Start(e) if e.name().as_ref() == b"failure" => {
                failure = true;
                if let Some(c) = &mut current {
                    c.outcome = "fail".into();
                    c.message = Some(String::new());
                }
            }
            Event::Text(e) if failure => {
                if let Some(c) = &mut current {
                    c.message
                        .as_mut()
                        .unwrap()
                        .push_str(&quick_xml::escape::unescape(&e.decode()?)?);
                }
            }
            Event::GeneralRef(e) if failure => {
                if let Some(c) = &mut current {
                    c.message
                        .as_mut()
                        .unwrap()
                        .push_str(&quick_xml::escape::unescape(&format!("&{};", e.decode()?))?);
                }
            }
            Event::CData(e) if failure => {
                if let Some(c) = &mut current {
                    c.message.as_mut().unwrap().push_str(&e.decode()?);
                }
            }
            Event::End(e) if e.name().as_ref() == b"failure" => failure = false,
            Event::End(e) if e.name().as_ref() == b"testcase" => {
                if let Some(c) = current.take() {
                    out.push(c);
                }
                failure = false;
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if let Some(c) = current {
        out.push(c);
    }
    Ok(out)
}
