import { Database } from 'bun:sqlite';
import { PGlite, type PGliteInterface } from '@electric-sql/pglite';
import { copyFile,readFile,writeFile,rm,unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { type SqlRow, required } from './db';

const dir=resolve('pglite-data');if(dir!==resolve(process.cwd(),'pglite-data'))throw new Error('unexpected PGlite reset path');
await rm(dir,{recursive:true,force:true});await copyFile('../seed.db','pglite-seed.db');
const seed=new Database('pglite-seed.db',{readonly:true});
const pg=await PGlite.create(dir,{relaxedDurability:false});
const start=performance.now();const loaded:Record<string,number>={};
const param=z.union([z.string(),z.number(),z.null()]);const row=z.record(z.string(),param);
const insert=async(store:Pick<PGliteInterface,'query'>,table:string,columns:string[],values:SqlRow[])=>{
  for(let i=0;i<values.length;i+=1000){const chunk=values.slice(i,i+1000);let n=0;const marks=chunk.map(r=>`(${r.map(()=>`$${++n}`).join(',')})`).join(',');await store.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES ${marks}`,chunk.flat());}
};
let metadata:unknown;
try{
  await pg.exec(await readFile('../schema.pg.sql','utf8'));await pg.exec('SET synchronous_commit=on;');
  for(const[table,where]of [
    ['project',''],['folder',''],['kase',' WHERE id<=10000'],['version',' WHERE case_id<=10000'],
    ['test',' WHERE id<=10000'],['target',''],['batch',''],['signature',''],
    ['result',' WHERE test<=10000 ORDER BY id LIMIT 100000'],
    ['question'," WHERE (state='open' AND id<=5000) OR (state='decided' AND id<=51000)"],
    ['decision',' WHERE question<=51000'],['command',' WHERE seq<=10000'],['run',''],['placement_history',' WHERE case_id<=10000'],
  ] satisfies [string,string][]){
    const cols=z.array(z.object({name:z.string()})).parse(seed.query(`PRAGMA table_info(${table})`).all()).map(c=>c.name);
    const records=z.array(row).parse(seed.query(`SELECT * FROM ${table}${where}`).all());
    await pg.transaction(async tx=>insert(tx,table,cols,records.map(r=>cols.map(c=>required(r[c],`column ${c}`)))));
    loaded[table]=records.length;process.stderr.write(JSON.stringify({event:'subset-loaded',table,rows:records.length})+'\n');
  }
  const search=z.array(row).parse(seed.query('SELECT rowid case_id,project,folder,text FROM search_doc WHERE rowid<=10000').all());
  await pg.transaction(async tx=>insert(tx,'search_doc',['case_id','project','folder','text'],search.map(r=>['case_id','project','folder','text'].map(c=>required(r[c],c)))));loaded.search_doc=search.length;
  await pg.exec(await readFile('../schema.pg.indexes.sql','utf8'));
  await pg.exec('VACUUM (ANALYZE)');
  metadata={pgliteVersion:'0.5.8',databaseVersion:(await pg.query('SELECT version() version')).rows,loadMs:performance.now()-start,loaded,settings:(await pg.query("SELECT name,setting,context FROM pg_settings WHERE name IN ('fsync','synchronous_commit','shared_buffers','max_parallel_workers_per_gather') ORDER BY name")).rows,filesystem:'Native NodeFS at pglite-data; relaxedDurability=false; no memory database',limitations:'10% cases and results, 5,000 open questions plus 1,000 decided; 10,000 tests retained so W5 still resolves 9,900 keys. Folder pages hold 10-20 rows, not the full 50. Other small parent tables retained. PGlite rejects SET fsync=on and fails startup when fsync=on is forced, so power-loss durability parity is not proven; these timings are not durability-comparable.'};
}finally{seed.close();await pg.close();await unlink('pglite-seed.db');}
await writeFile('pglite-seed-info.json',JSON.stringify(metadata,null,2)+'\n');
const child=spawn('bun',['src/bench.ts'],{env:{...process.env,PGLITE_MODULE:'@electric-sql/pglite',MODE:'pglite',RUNTIME:'bun',CASE_COUNT:'10000',ONLY_TO_W5:'1',SKIP_MIX:'1',RESULT_FILE:'pglite.json',PGLITE_PATH:dir,PORT:'30456'},stdio:'inherit'});
const code=await new Promise<number|null>((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});
if(code!==0)throw new Error(`PGlite workloads exited ${code}`);
