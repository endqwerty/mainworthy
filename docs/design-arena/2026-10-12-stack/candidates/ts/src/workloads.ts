import { createHash } from 'node:crypto';
import { z } from 'zod';
import { type Db, type SqlRow, marks, one, required, select } from './db';
import {
  bodySchema, caseRow, countRow, folderInput, gateInput, getInput, idRow, number,
  proposeInput, proposeOutput, questionRow, reportInput, resultRow, runRow,
  searchInput, seqRow, signatureRow, testInput, testRow, type CaseBody, type ProposeInput, type ReportInput,
} from './schemas';

export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const normalize = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();
export const searchText = (body: CaseBody) => [body.title, ...body.steps.flatMap(step => [step.action, step.expected ?? ''])].join(' ');
const textRow = z.object({ outcome: z.string() });
const batchRow = z.object({ id: number, seq: number });
const searchRow = z.object({ id: number, ref_no: number, title: z.string(), folder: number, score: number, text: z.string() });
const glyphRow = z.object({ case_id: number, test: number, outcome: z.string().nullable() });
const messagesUpperBound = (results: ReportInput['results']) => 4 + new Set(results.filter(x => x.outcome === 'fail').map(x => normalize(x.message ?? 'failure'))).size * 2;

export class Workloads {
  private seedSignatureHashes = new Map<string, string>();
  constructor(readonly db: Db) {}
  async init(): Promise<void> {
    const signatures = await select(this.db, signatureRow, 'SELECT id,hash,sample FROM signature WHERE project=1 ORDER BY id LIMIT 40');
    for (const signature of signatures) this.seedSignatureHashes.set(normalize(signature.sample), signature.hash);
  }
  async fixtures() {
    return {
      tests: await select(this.db, z.object({ id: number, key: z.string() }), 'SELECT id,key FROM test WHERE project=1 ORDER BY id LIMIT 9900'),
      signatures: await select(this.db, signatureRow, 'SELECT id,hash,sample FROM signature WHERE project=1 ORDER BY id LIMIT 10'),
      commits: (await select(this.db, z.object({ commit_sha: z.string() }), 'SELECT commit_sha FROM run WHERE project=1 ORDER BY id LIMIT 200')).map(x => x.commit_sha),
    };
  }
  async get(input: z.infer<typeof getInput>) {
    const row = await one(this.db, caseRow.extend({ body: z.string() }),
      'SELECT k.*,v.body FROM kase k JOIN version v ON v.case_id=k.id AND v.no=k.head_no WHERE k.project=1 AND k.ref_no=$1', [input.ref]);
    return { ...row, body: bodySchema.parse(JSON.parse(row.body)) };
  }
  async folder(input: z.infer<typeof folderInput>) {
    const rows = await select(this.db, caseRow, 'SELECT * FROM kase WHERE project=1 AND folder=$1 AND rank>$2 ORDER BY rank LIMIT 50', [input.folder, input.cursor]);
    const ids = rows.map(row => row.id);
    const glyphs = ids.length ? await select(this.db, glyphRow,
      `SELECT t.case_id,t.id test,(SELECT r.outcome FROM result r WHERE r.project=1 AND r.test=t.id ORDER BY r.seq DESC,r.ord DESC LIMIT 1) outcome FROM test t WHERE t.project=1 AND t.case_id IN (${marks(ids.length)}) ORDER BY t.case_id,t.id`, ids) : [];
    const { n } = await one(this.db, countRow, "SELECT count(*) n FROM question WHERE project=1 AND state='open'");
    const byCase = new Map<number, { test: number; outcome: string | null }[]>();
    for (const glyph of glyphs) {
      let list = byCase.get(glyph.case_id);
      if (!list) { list = []; byCase.set(glyph.case_id, list); }
      list.push({ test: glyph.test, outcome: glyph.outcome });
    }
    return { items: rows.map(row => ({ ...row, linkedTests: byCase.get(row.id)?.length ?? 0, last: byCase.get(row.id) ?? [] })), open: n, reads: 3 };
  }
  async search(input: z.infer<typeof searchInput>) {
    const lo = input.area === null ? 21 : 21 + (input.area - 1) * 24;
    const hi = input.area === null ? 500 : lo + 23;
    return {items:z.array(searchRow).parse(await this.db.search(input.text,lo,hi))};
  }
  async propose(input: ProposeInput) {
    return this.db.transaction(async db => {
      await db.lockProject();
      const previous = await select(db, textRow, 'SELECT outcome FROM command WHERE id=$1', [input.cmd]);
      if (previous[0]) return proposeOutput.parse(JSON.parse(previous[0].outcome));
      const old = await one(db, caseRow, 'SELECT * FROM kase WHERE project=1 AND ref_no=$1', [input.ref]);
      if (input.base !== undefined && input.base !== old.head_no) throw new Error(`Version conflict: expected ${input.base}, current ${old.head_no}`);
      await db.exec("INSERT INTO command(id,project,op,actor,seq,outcome) VALUES($1,1,'propose',1,0,'{}')", [input.cmd]);
      const { seq } = await one(db, seqRow, 'UPDATE project SET seq=seq+1 WHERE id=1 RETURNING seq');
      const ids = await db.ids(2);
      const q = required(ids[0], 'question id');
      const d = required(ids[1], 'decision id');
      const version = old.head_no + 1;
      const body = JSON.stringify(input.body);
      const bodyHash = hash(body);
      const evidence = JSON.stringify({ case: old.id, version, command: input.cmd, previous: old.head_no });
      const evidenceHash = hash(evidence);
      await db.exec("INSERT INTO question(id,project,ref_no,kind,fingerprint,epoch,state,owner,rank,evidence,evidence_hash,rev) VALUES($1,1,$1,'adopt',$2,0,'decided',0,$3,$4,$5,$3)", [q, hash(`adopt:${input.cmd}`), seq, evidence, evidenceHash]);
      await db.exec("INSERT INTO decision(id,project,question,kind,answer,basis,seq) VALUES($1,1,$2,'adopt',$3,$4,$5)", [d,q,JSON.stringify({ is: 'accept', version }),evidenceHash,seq]);
      const claimHash = hash(JSON.stringify({ pre: input.body.pre, steps: input.body.steps }));
      await db.exec('INSERT INTO version(case_id,no,parent,body,hash,claim_hash,seq) VALUES($1,$2,$3,$4,$5,$6,$7)', [old.id,version,old.head_no,body,bodyHash,claimHash,seq]);
      await db.exec('UPDATE kase SET head_no=$1,title=$2,head_hash=$3,rev=$4 WHERE id=$5', [version,input.body.title,bodyHash,seq,old.id]);
      await db.replaceSearch(old.id,old.folder,searchText(input.body));
      const out = { caseId: old.id, version, seq, hash: bodyHash };
      await db.exec('UPDATE command SET seq=$1,outcome=$2 WHERE id=$3', [seq,JSON.stringify(out),input.cmd]);
      return out;
    });
  }
  async report(input: ReportInput) {
    return this.db.transaction(async db => {
      await db.lockProject();
      const previous = await select(db, batchRow, 'SELECT id,seq FROM batch WHERE project=1 AND key=$1', [input.key]);
      if (previous[0]) return { batch: previous[0].id, inserted: 0, newTests: 0, failures: 0, signatures: 0, seq: previous[0].seq };
      const { seq } = await one(db, seqRow, 'UPDATE project SET seq=seq+1 WHERE id=1 RETURNING seq');
      const known = await select(db, testRow,
        `SELECT t.id,t.key,t.case_id,k.head_no FROM test t LEFT JOIN kase k ON k.id=t.case_id WHERE t.project=1 AND t.key IN (${marks(input.results.length)})`, input.results.map(result => result.key));
      const tests = new Map(known.map(test => [test.key, test]));
      const uniqueNew = [...new Set(input.results.filter(result => !tests.has(result.key)).map(result => result.key))];
      const ids = await db.ids(input.results.length + uniqueNew.length + messagesUpperBound(input.results));
      let ix = 0;
      const next = () => required(ids[ix++], 'allocated id');
      const newTestRows: SqlRow[] = uniqueNew.map(key => {
        const id = next(); tests.set(key, { id, key, case_id: null, head_no: null });
        return [id,1,key,null,key.split('::')[0] ?? key];
      });
      await db.bulk('test', ['id','project','key','case_id','file'], newTestRows);
      const targetId = next();
      await db.exec("INSERT INTO target(id,project,commit_sha,env) VALUES($1,1,$2,'ci') ON CONFLICT(project,commit_sha,env) DO NOTHING", [targetId,input.commit]);
      const { id: target } = await one(db, idRow, "SELECT id FROM target WHERE project=1 AND commit_sha=$1 AND env='ci'", [input.commit]);
      const batch = next();
      await db.exec("INSERT INTO batch(id,project,key,target,job,attempt,state,seq) VALUES($1,1,$2,$3,'arena',1,'complete',$4)", [batch,input.key,target,seq]);
      const failures = input.results.filter(result => result.outcome === 'fail');
      const messages = new Map<string, string>();
      for (const result of failures) {
        const sample = normalize(result.message ?? 'failure');
        messages.set(this.seedSignatureHashes.get(sample) ?? hash(sample), sample);
      }
      const newSignatureRows: SqlRow[] = [...messages].map(([h,sample]) => [next(),1,h,'assertion',sample]);
      await db.bulk('signature', ['id','project','hash','class','sample'], newSignatureRows, 'ON CONFLICT(project,hash) DO NOTHING');
      const signatures = messages.size ? await select(db, signatureRow, `SELECT id,hash,sample FROM signature WHERE project=1 AND hash IN (${marks(messages.size)})`, [...messages.keys()]) : [];
      const signatureIds = new Map(signatures.map(sig => [sig.hash,sig.id]));
      const resultRows: SqlRow[] = input.results.map((result, ord) => {
        const test = required(tests.get(result.key), 'resolved test');
        let signature:number|null=null;
        if(result.outcome==='fail'){
          const sample=normalize(result.message??'failure');
          signature=required(signatureIds.get(this.seedSignatureHashes.get(sample)??hash(sample)),'failure signature');
        }
        return [next(),1,test.id,seq,ord,batch,target,result.outcome,test.case_id === null ? 'unresolved' : 'assumed',test.case_id,test.head_no,result.durationMs,signature,result.message ?? null];
      });
      await db.bulk('result', ['id','project','test','seq','ord','batch','target','outcome','basis','basis_case','basis_version','duration_ms','signature','message'], resultRows);
      for (const sig of signatures) {
        const fingerprint = hash(`failure:${sig.id}`);
        const open = await select(db, idRow, "SELECT id FROM question WHERE project=1 AND fingerprint=$1 AND state='open' ORDER BY epoch DESC LIMIT 1", [fingerprint]);
        if (open.length) continue;
        const q = next();
        const evidence = JSON.stringify({ signature: sig.id, batch, count: failures.filter(result => normalize(result.message ?? 'failure') === sig.sample).length, sample: sig.sample });
        await db.exec("INSERT INTO question(id,project,ref_no,kind,fingerprint,epoch,state,owner,rank,evidence,evidence_hash,rev) VALUES($1,1,$1,'failure',$2,0,'open',0,$3,$4,$5,$3)", [q,fingerprint,seq,evidence,hash(evidence)]);
      }
      const tally = JSON.stringify({ total: input.results.length, pass: input.results.length-failures.length, fail: failures.length });
      await db.exec('INSERT INTO run(id,project,commit_sha,verdict,tally,outstanding,rev) VALUES($1,1,$2,$3,$4,0,$5) ON CONFLICT(project,commit_sha) DO UPDATE SET verdict=excluded.verdict,tally=excluded.tally,rev=excluded.rev', [next(),input.commit,failures.length ? 'failed' : 'passed',tally,seq]);
      return { batch, inserted: resultRows.length, newTests: newTestRows.length, failures: failures.length, signatures: signatures.length, seq };
    });
  }
  async history(input: z.infer<typeof testInput>) {
    return { items: await select(this.db, resultRow, 'SELECT * FROM result WHERE project=1 AND test=$1 ORDER BY seq DESC,ord DESC LIMIT 20', [input.test]) };
  }
  async gate(input: z.infer<typeof gateInput>) {
    const row = await one(this.db, runRow, 'SELECT * FROM run WHERE project=1 AND commit_sha=$1', [input.commit]);
    return { ...row, tally: z.record(z.string(), z.json()).parse(JSON.parse(row.tally)) };
  }
  async queue() {
    const rows = await select(this.db, questionRow, "SELECT * FROM question WHERE project=1 AND state='open' ORDER BY owner,rank LIMIT 50");
    const { n } = await one(this.db, countRow, "SELECT count(*) n FROM question WHERE project=1 AND state='open'");
    return { items: rows.map(row => ({ ...row, evidence: z.record(z.string(), z.json()).parse(JSON.parse(row.evidence)) })), open: n };
  }
  async counts() {
    const counts: Record<string, number> = {};
    for (const table of ['version','question','decision','command','test','target','batch','result','signature','run']) {
      counts[table] = (await one(this.db, countRow, `SELECT count(*) n FROM ${table}`)).n;
    }
    counts.seq = (await one(this.db, seqRow, 'SELECT seq FROM project WHERE id=1')).seq;
    counts.open = (await one(this.db, countRow, "SELECT count(*) n FROM question WHERE project=1 AND state='open'")).n;
    return counts;
  }
  async auditBatch(batch: number) {
    const stats = await one(this.db, z.object({ n:number, failures:number, assumed:number, unresolved:number, bad:number }),
      "SELECT count(*) n,sum(CASE WHEN outcome='fail' THEN 1 ELSE 0 END) failures,sum(CASE WHEN basis='assumed' THEN 1 ELSE 0 END) assumed,sum(CASE WHEN basis='unresolved' THEN 1 ELSE 0 END) unresolved,sum(CASE WHEN basis='assumed' AND (basis_case IS NULL OR basis_version IS NULL) OR basis='unresolved' AND (basis_case IS NOT NULL OR basis_version IS NOT NULL) THEN 1 ELSE 0 END) bad FROM result WHERE project=1 AND batch=$1", [batch]);
    const duplicateQuestions = (await one(this.db, countRow, "SELECT count(*) n FROM (SELECT fingerprint FROM question WHERE project=1 AND state='open' GROUP BY fingerprint HAVING count(*)>1) d")).n;
    return { ...stats, duplicateQuestions };
  }
  async rollbackProof() {
    const before=await this.counts();const headBefore=await this.get({ref:1});
    const inject=(db:Db):Db=>({...db,
      exec:async(sql,params=[])=>{if(sql.startsWith('UPDATE kase SET'))throw new Error('injected rollback after version insert');await db.exec(sql,params);},
      transaction:fn=>db.transaction(tx=>fn(inject(tx))),
    });
    const failing=new Workloads(inject(this.db));
    try{await failing.propose({cmd:'arena-rollback-proof',ref:1,body:{...headBefore.body,title:'Rollback must never adopt this title'}});throw new Error('failure was not injected');}
    catch(error){if(!(error instanceof Error)||error.message!=='injected rollback after version insert')throw error;}
    const after=await this.counts();const headAfter=await this.get({ref:1});
    if(JSON.stringify(before)!==JSON.stringify(after)||JSON.stringify(headBefore)!==JSON.stringify(headAfter))throw new Error('seal-save transaction rollback failed');
    return {before:before.seq,after:after.seq,tableCountsUnchanged:true,headUnchanged:true,check:'injected after command, sequence, question, decision, and version writes; all rolled back'};
  }
  async dispatch(name: string, raw: unknown): Promise<unknown> {
    switch (name) {
      case 'folder': return this.folder(folderInput.parse(raw));
      case 'search': return this.search(searchInput.parse(raw));
      case 'history': return this.history(testInput.parse(raw));
      case 'gate': return this.gate(gateInput.parse(raw));
      case 'queue': return this.queue();
      default: throw new Error(`Unknown workload ${name}`);
    }
  }
}
