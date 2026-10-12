import { readFile,writeFile } from 'node:fs/promises';
import { openPg } from './db-pg';
import { Workloads } from './workloads';

const db=await openPg('bun');const ctx=new Workloads(db);await ctx.init();
const old=`SELECT k.id,k.ref_no,k.title,k.folder,ts_rank_cd(s.tsv,q.term)::float8 score,s.text FROM search_doc s CROSS JOIN (SELECT plainto_tsquery('simple',$1) term) q JOIN kase k ON k.id=s.case_id WHERE s.project=1 AND s.folder BETWEEN $2 AND $3 AND s.tsv @@ q.term ORDER BY score DESC,k.id LIMIT 50`;
const newQuery=`WITH term AS MATERIALIZED (SELECT plainto_tsquery('simple',$1) term), hits AS MATERIALIZED (SELECT s.case_id,ts_rank_cd(s.tsv,term.term)::float8 score FROM search_doc s CROSS JOIN term WHERE s.project=1 AND s.folder BETWEEN $2 AND $3 AND s.tsv @@ term.term ORDER BY score DESC,s.case_id LIMIT 50) SELECT k.id,k.ref_no,k.title,k.folder,hits.score,s.text FROM hits JOIN kase k ON k.id=hits.case_id JOIN search_doc s ON s.case_id=hits.case_id ORDER BY hits.score DESC,k.id`;
const queries=(await readFile('../queries.txt','utf8')).trim().split('\n').slice(0,50);
const trials:{round:number;shape:string;p50:number;p95:number;max:number}[]=[];
const plans:Record<string,unknown>={};
try{
  for(let round=0;round<5;round++)for(const[shape,query]of round%2===0?[['old',old],['new',newQuery]]:[['new',newQuery],['old',old]]){
    const times:number[]=[];
    for(const text of queries){const start=performance.now();const result=await db.all(query??'', [text,21,500]);if(!Array.isArray(result)||result.length>50)throw new Error('search result shape');times.push(performance.now()-start);}
    times.sort((a,b)=>a-b);trials.push({round,shape:shape??'',p50:times[24]??0,p95:times[47]??0,max:times.at(-1)??0});
  }
  for(const[shape,query]of [['old',old],['new',newQuery]])plans[shape??'']=await db.all('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+query,['large',21,500]);
  plans.queueCount=await db.all("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT count(*) FROM question WHERE project=1 AND state='open'");
  await writeFile('search-profile.json',JSON.stringify({trials,plans,check:'Five alternating 50-query trials per SQL shape; untimed EXPLAIN ANALYZE collected separately. Full 500-query workload is the reported product latency.'},null,2)+'\n');
}finally{await db.close();}
