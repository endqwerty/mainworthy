import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { required } from './db';
import { bodySchema, caseRow, getOutput, number, proposeOutput, reportOutput, resultRow, signatureRow } from './schemas';
import { generateJUnit, parseJUnit } from './xml';

const mode = process.env.MODE ?? 'embedded';
const runtime = process.env.RUNTIME ?? 'bun';
const port = Number(process.env.PORT ?? 30452);
const root = process.cwd();
const caseCount=Number(process.env.CASE_COUNT??100000);
const url = `http://127.0.0.1:${port}`;
const countsSchema = z.record(z.string(), z.number());
const fixturesSchema = z.object({
  tests: z.array(z.object({ id: number, key: z.string() })), signatures: z.array(signatureRow), commits: z.array(z.string()),
});
const folderOutput = z.object({ items: z.array(caseRow.extend({ linkedTests: number, last: z.array(z.object({ test: number, outcome: z.string().nullable() })) })), open: number, reads: number });
const searchOutput = z.object({ items: z.array(z.object({ id: number, ref_no: number, title: z.string(), folder: number, score: number, text: z.string() })) });
const queueOutput = z.object({ items: z.array(z.object({ id:number, state:z.string(), owner:number, rank:number, evidence:z.record(z.string(),z.json()) })), open:number });
const gateOutput = z.object({ commit_sha:z.string(), tally:z.record(z.string(),z.json()) });
const historyOutput = z.object({ items: z.array(resultRow) });
const sampleSchema = z.object({ value:z.unknown(), ms:z.number(), operationMs:z.number(), dbMs:z.number(), queries:z.number() });
type Sample = z.infer<typeof sampleSchema>;
let rng = 0x12345678;
const random = (max: number) => { rng = (Math.imul(rng,1664525)+1013904223) >>> 0; return rng % max; };
function assert(condition: boolean, message: string): asserts condition { if (!condition) throw new Error(message); }
export const summarize = (values: number[], errors = 0, check = '') => {
  const sorted = values.toSorted((a,b) => a-b);
  const p = (q: number) => sorted[Math.max(0,Math.ceil(sorted.length*q)-1)] ?? 0;
  return { p50:p(.5), p95:p(.95), p99:p(.99), max:sorted.at(-1) ?? 0, errors, check, samples:values.length };
};
async function request(path: string, input?: unknown): Promise<Sample> {
  const start = performance.now();
  const response = await fetch(url+path, input === undefined ? undefined : { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(input), keepalive:true });
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(value).slice(0,400)}`);
  return { value, ms:performance.now()-start, operationMs:Number(response.headers.get('x-operation-ms')), dbMs:Number(response.headers.get('x-db-ms')), queries:Number(response.headers.get('x-queries')) };
}
const counts = async () => countsSchema.parse((await request('/counts')).value);
const getCount = (value: Record<string,number>, key: string) => required(value[key], `count ${key}`);
function delta(before: Record<string,number>, after: Record<string,number>, key: string, expected: number) {
  assert(getCount(after,key)-getCount(before,key)===expected, `${key}: expected delta ${expected}, got ${getCount(after,key)-getCount(before,key)}`);
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const end = new Promise<void>(resolve => child.once('exit', () => resolve()));
  await Promise.race([end,delay(5000).then(() => { if (child.exitCode===null) child.kill('SIGKILL'); })]);
}
async function start(binary = false): Promise<{ child:ChildProcess; ms:number }> {
  const t = performance.now();
  const executable = binary ? `${root}/dist/casebook` : runtime==='node' ? 'node' : 'bun';
  const args = binary ? ['serve'] : [`${root}/dist/${runtime==='node'?'node':'server'}.js`,'serve'];
  const child = spawn(executable,args,{ cwd:root,env:{ ...process.env,MODE:mode,RUNTIME:runtime,PORT:String(port) },stdio:['ignore','ignore','pipe'] });
  let diagnostics = '';
  child.stderr?.on('data', chunk => { diagnostics += String(chunk); });
  for (let i=0;i<2000;i++) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${diagnostics}`);
    try { const response = await fetch(url+'/health'); if (response.ok) {
      if(Number(response.headers.get('x-process-pid'))!==child.pid){await stop(child);throw new Error('Port belongs to another process; refusing contaminated benchmark');}
      getOutput.parse(await response.json()); return { child,ms:performance.now()-t };
    } }
    catch(error) {if(error instanceof Error&&error.message.startsWith('Port belongs'))throw error;}
    await delay(5);
  }
  await stop(child);
  throw new Error(`server startup timed out: ${diagnostics}`);
}

async function main() {
  const cold: number[] = [];
  for (let i=0;i<5;i++) { const item=await start(); cold.push(item.ms); await stop(item.child); }
  const binaryCold: number[]=[];
  if (runtime==='bun' && mode==='embedded') for (let i=0;i<5;i++) { const item=await start(true); binaryCold.push(item.ms); await stop(item.child); }
  const { child } = await start();
  const out: Record<string,unknown> = { coldStart:{...summarize(cold), trials:cold}, binaryColdStart:binaryCold.length ? {...summarize(binaryCold),trials:binaryCold} : null };
  let totalErrors=0;
  try {
    const fixture = fixturesSchema.parse((await request('/fixtures')).value);
    assert(fixture.tests.length===9900 && fixture.commits.length===200 && fixture.signatures.length===10,'seed fixture dimensions');
    const initial=await counts();
    out.initialCounts=initial;
    const rollback=z.object({before:number,after:number}).parse((await request('/rollback',{})).value);
    assert(rollback.before===rollback.after,'rollback sequence');
    out.rollback=rollback;
    let saveIndex=0;
    let reportIndex=0;
    const saved: { input:unknown; receipt:z.infer<typeof proposeOutput> }[]=[];
    let lastSave: { input:z.infer<typeof import('./schemas').proposeInput>; receipt:z.infer<typeof proposeOutput> } | undefined;
    let lastReport: { input:z.infer<typeof import('./schemas').reportInput>; receipt:z.infer<typeof reportOutput> } | undefined;
    const makeSave=()=> {
      const i=saveIndex++;
      return { cmd:`${mode}-${runtime}-save-${i}`, ref:random(caseCount)+1, body:bodySchema.parse({
        title:`arena savemark${i} adopted case`,pre:'A user is signed in and can edit the selected case.',
        steps:Array.from({length:3},(_,j)=>({id:`s${j}`,action:`Perform action ${j} for command ${i}, preserving all linked evidence.`,expected:j===2?null:'The expected result is visible and the previous history remains intact.'})),
        methods:[{m:'human'}],intent:{automate:'none'},fields:{author:'arena'},
      }) };
    };
    const makeReport=()=> {
      const i=reportIndex++;
      const key=`${mode}-${runtime}-report-${i}`;
      const results=z.array(importResultSchema()).parse(Array.from({length:10000},(_,j)=>({
        key:j<9900?required(fixture.tests[j],'seed test').key:`arena/new/${key}::test ${j}`,
        outcome:j<200?'fail':'pass',durationMs:10+j%1000,
        ...(j<200?{message:j%20<10?required(fixture.signatures[j%20],'seed signature').sample:`Arena novel failure type ${j%20-10} for report ${key}`} : {}),
      })));
      return {key,commit:`arena-commit-${key}`,results};
    };
    const run=async (id:string,iterations:number,fn:(i:number)=>Promise<Sample>,check:string) => {
      const values:number[]=[]; const operations:number[]=[]; const database:number[]=[];
      let errors=0; let warmupErrors=0; const failures:string[]=[];
      for(let i=-100;i<iterations;i++) {
        const t=performance.now();
        try {
          const result=await fn(i);
          if(i>=0) { values.push(result.ms); operations.push(result.operationMs); database.push(result.dbMs); }
        } catch(error) {
          if(i>=0) { errors++;values.push(performance.now()-t); } else warmupErrors++;
          if(failures.length<5) failures.push(error instanceof Error?error.message:String(error));
        }
      }
      totalErrors+=errors+warmupErrors;
      const result={...summarize(values,errors,check),warmup:100,warmupErrors,failures,operation:summarize(operations),db:summarize(database)};
      out[id]=result;
      process.stderr.write(JSON.stringify({mode,runtime,id,p95:result.p95,max:result.max,errors,warmupErrors})+'\n');
    };
    await run('W1',2000,async()=>{
      const ref=random(caseCount)+1; const response=await request('/api/get',{ref});const value=getOutput.parse(response.value);
      assert(value.ref_no===ref&&value.title===value.body.title&&value.project===1,'get ref/head/title');return response;
    },'every requested ref matched the head body/title');
    await run('W2',1000,async()=>{
      const input={folder:random(480)+21,cursor:random(caseCount>=100000?150:10)*1000};const response=await request('/bench/folder',input);const value=folderOutput.parse(response.value);
      assert((caseCount>=100000?value.items.length===50:value.items.length>0&&value.items.length<=50)&&value.open>=getCount(initial,'open')&&response.queries===3,'folder page/read count');
      let rank=input.cursor;
      for(const row of value.items) { assert(row.folder===input.folder&&row.rank>rank&&row.linkedTests===row.last.length&&row.linkedTests===(row.id<=15000?1:0),'folder order/glyph counts');rank=row.rank; }
      return response;
    },'50 ordered rows after cursor, exact seeded links, latest outcomes, 3 reads');
    const queries=(await readFile('../queries.txt','utf8')).trim().split('\n');
    let matches=0;
    await run('W3',500,async(i)=>{
      const input={text:required(queries[(i+100)%500],'search query'),area:(i+100)%5===0?random(20)+1:null};
      const response=await request('/bench/search',input);const value=searchOutput.parse(response.value);assert(value.items.length<=50,'search bounded');
      let score=Infinity;
      for(const row of value.items) {
        assert(input.text.split(/\s+/).every(term=>row.text.toLowerCase().includes(term.toLowerCase())),'AND search matches');
        assert(row.score<=score+1e-12,'search relevance order');score=row.score;
        if(input.area!==null) {const lo=21+(input.area-1)*24;assert(row.folder>=lo&&row.folder<=lo+23,'area filter');}
      }
      if(i>=0) matches+=value.items.length;return response;
    },'AND matches, relevance order, 20% area filter');
    out.searchReturnedRows=matches;
    const beforeSaves=await counts();
    await run('W4',1000,async()=>{
      const input=makeSave();const response=await request('/api/propose',input);const receipt=proposeOutput.parse(response.value);
      assert(receipt.caseId===input.ref&&receipt.version>1,'save receipt');lastSave={input,receipt};if(saved.length<20)saved.push({input,receipt});return response;
    },'1,100 versions/commands/decided adopt questions/decisions and sequence increments');
    const afterSaves=await counts();
    for(const table of ['version','command','question','decision','seq'])delta(beforeSaves,afterSaves,table,1100);
    for(const item of saved){const replay=proposeOutput.parse((await request('/api/propose',item.input)).value);assert(JSON.stringify(replay)===JSON.stringify(item.receipt),'stored command outcome');}
    assert(JSON.stringify(await counts())===JSON.stringify(afterSaves),'command replay writes nothing');
    const seal=required(lastSave,'last save');const head=getOutput.parse((await request('/api/get',{ref:seal.input.ref})).value);
    assert(head.head_no===seal.receipt.version&&head.head_hash===seal.receipt.hash&&head.title===seal.input.body.title,'saved head');
    const findSaved=searchOutput.parse((await request('/bench/search',{text:`savemark${saveIndex-1}`,area:null})).value);
    assert(findSaved.items.some(row=>row.id===seal.receipt.caseId),'transactional full-text replacement');
    out.commandReplay={commands:20,before:afterSaves,after:await counts(),searchReplacement:true};
    const beforeReports=await counts();
    await run('W5',20,async()=>{
      const input=makeReport();const response=await request('/api/report',input);const receipt=reportOutput.parse(response.value);
      assert(receipt.inserted===10000&&receipt.newTests===100&&receipt.failures===200&&receipt.signatures===20,'report dimensions');lastReport={input,receipt};return response;
    },'120 transactions persisted 1,200,000 results; 100 new tests/200 fails/20 signatures each');
    const afterReports=await counts();
    for(const [table,n] of [['result',1200000],['test',12000],['batch',120],['target',120],['run',120],['seq',120],['signature',1200],['question',1210]] satisfies [string,number][])delta(beforeReports,afterReports,table,n);
    const report=required(lastReport,'last report');
    const audit=z.object({n:number,failures:number,assumed:number,unresolved:number,bad:number,duplicateQuestions:number}).parse((await request(`/audit/${report.receipt.batch}`)).value);
    assert(audit.n===10000&&audit.failures===200&&audit.assumed===9900&&audit.unresolved===100&&audit.bad===0&&audit.duplicateQuestions===0,'result rows/basis/questions');
    const runGate=gateOutput.parse((await request('/bench/gate',{commit:report.input.commit})).value);assert(runGate.tally.total===10000&&runGate.tally.fail===200,'run tally');
    const replay=reportOutput.parse((await request('/api/report',report.input)).value);assert(replay.inserted===0,'batch replay receipt');assert(JSON.stringify(await counts())===JSON.stringify(afterReports),'batch replay writes nothing');
    out.batchReplay={audit,before:afterReports,after:await counts(),replay};
    const xml=generateJUnit();await writeFile('junit.xml',xml);
    await run('W5a',20,async()=>{
      const start=performance.now();const parsed=parseJUnit(xml);const ms=performance.now()-start;
      assert(parsed.length===10000&&parsed.filter(x=>x.outcome==='fail').length===200&&parsed[0]?.message!==undefined,'JUnit rows/failures/message');
      return {value:null,ms,operationMs:ms,dbMs:0,queries:0};
    },'10,000 testcase nodes, 200 failure bodies retained');
    if(process.env.ONLY_TO_W5==='1'){
      out.memory=z.object({rssMB:number,pid:number}).parse((await request('/stats')).value);out.finalCounts=await counts();out.totalErrors=totalErrors;
      out.subset={caseCount,folderPage:'10-20 rows because only 10% of cases are loaded; SQL still LIMIT 50',workloads:'W1-W5 and W5a only'};
      if(totalErrors)process.exitCode=1;return;
    }
    await run('W6',2000,async()=>{
      const test=random(20000)+1;const response=await request('/bench/history',{test});const value=historyOutput.parse(response.value);assert(value.items.length===20,'history length');
      let seq=Infinity;let ord=Infinity;for(const row of value.items){assert(row.test===test&&(row.seq<seq||(row.seq===seq&&row.ord<=ord)),'descending history');seq=row.seq;ord=row.ord;}return response;
    },'20 results for selected test in descending sequence/ordinal');
    await run('W7',2000,async()=>{const commit=required(fixture.commits[random(200)],'commit');const response=await request('/bench/gate',{commit});assert(gateOutput.parse(response.value).commit_sha===commit,'gate commit');return response;},'selected commit matched persisted run');
    await run('W8',1000,async()=>{const response=await request('/bench/queue',{});const value=queueOutput.parse(response.value);assert(value.items.length===50&&value.open===getCount(afterReports,'open'),'queue count');let owner=-1;let rank=-1;for(const row of value.items){assert(row.state==='open'&&(row.owner>owner||(row.owner===owner&&row.rank>=rank)),'queue order');owner=row.owner;rank=row.rank;}return response;},'50 open questions, parsed evidence, ordered owner/rank, exact open count');
    if(process.env.SKIP_MIX!=='1') {
      const reads:number[]=[];const saves:number[]=[];const ingests:number[]=[];let errors=0;let readCount=0;const errorMessages:string[]=[];
      const mixStart=performance.now();const end=mixStart+20000;
      const capture=async(fn:()=>Promise<Sample>,arr:number[],check:(value:unknown)=>void) => { try {const sample=await fn();check(sample.value);arr.push(sample.ms);}catch(error){errors++;if(errorMessages.length<5)errorMessages.push(String(error));} };
      const readers=Array.from({length:16},(_,client)=>(async()=>{
        let i=client;
        while(performance.now()<end){
          const which=i++%5;
          if(which===0){const ref=random(100000)+1;await capture(()=>request('/api/get',{ref}),reads,value=>assert(getOutput.parse(value).ref_no===ref,'mixed get'));}
          if(which===1){const folder=random(480)+21;await capture(()=>request('/bench/folder',{folder,cursor:0}),reads,value=>assert(folderOutput.parse(value).items.length===50,'mixed folder'));}
          if(which===2){const test=random(20000)+1;await capture(()=>request('/bench/history',{test}),reads,value=>assert(historyOutput.parse(value).items[0]?.test===test,'mixed history'));}
          if(which===3){const commit=required(fixture.commits[random(200)],'mix commit');await capture(()=>request('/bench/gate',{commit}),reads,value=>assert(gateOutput.parse(value).commit_sha===commit,'mixed gate'));}
          if(which===4)await capture(()=>request('/bench/queue',{}),reads,value=>assert(queueOutput.parse(value).items.length===50,'mixed queue'));
          readCount++;
        }
      })());
      const writer=(async()=>{while(performance.now()<end){const input=makeReport();await capture(()=>request('/api/report',input),ingests,value=>assert(reportOutput.parse(value).inserted===10000,'mixed report'));}})();
      const saver=(async()=>{while(performance.now()<end){const input=makeSave();await capture(()=>request('/api/propose',input),saves,value=>assert(proposeOutput.parse(value).caseId===input.ref,'mixed save'));}})();
      await Promise.all([...readers,writer,saver]);
      const elapsedSeconds=(performance.now()-mixStart)/1000;
      out.W9={...summarize(reads,errors,'16 reader clients, 1 ingest client, 1 save client; response checks'),readsPerSecond:reads.length/elapsedSeconds,attemptedReads:readCount,elapsedSeconds,readers:16,ingest:summarize(ingests),save:summarize(saves),ingestTimes:ingests,errorMessages};
      totalErrors+=errors;
      process.stderr.write(JSON.stringify({mode,runtime,id:'W9',readP95:summarize(reads).p95,readsPerSecond:reads.length/elapsedSeconds,ingests:ingests.length,saves:saves.length,errors})+'\n');
    }
    out.memory=z.object({rssMB:number,pid:number}).parse((await request('/stats')).value);
    out.finalCounts=await counts();
    out.totalErrors=totalErrors;
  } finally {
    await writeFile(`${process.env.RESULT_FILE ?? mode+'.json'}`,JSON.stringify(out,null,2)+'\n');
    await stop(child);
  }
  if(totalErrors)process.exitCode=1;
}
function importResultSchema(){return z.object({key:z.string(),outcome:z.enum(['pass','fail']),durationMs:z.number().int(),message:z.string().optional()});}
await main();
