import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { openPg } from './db-pg';
import { required } from './db';
import { Workloads } from './workloads';
import { reportInput } from './schemas';

const clients = await Promise.all(['bun','postgres'].map(async driver => {
  const db=await openPg(driver);const workloads=new Workloads(db);await workloads.init();return {driver,db,workloads};
}));
const fixture=await required(clients[0],'Bun client').workloads.fixtures();
const measurements: Record<string,{point:number[];ingest:number[]}>={bun:{point:[],ingest:[]},postgres:{point:[],ingest:[]}};
try {
  for(let round=-1;round<5;round++)for(const client of round%2===0?clients:clients.toReversed()){
    for(let i=0;i<100;i++)await client.workloads.get({ref:i*997%100000+1});
    const points:number[]=[];
    for(let i=0;i<1000;i++){const start=performance.now();const row=await client.workloads.get({ref:i*997%100000+1});if(!row.body.title)throw new Error('point correctness');points.push(performance.now()-start);}
    const key=`driver-${client.driver}-${round}`;
    const input=reportInput.parse({key,commit:key,results:Array.from({length:10000},(_,i)=>({
      key:i<9900?required(fixture.tests[i],'fixture test').key:`driver-new-${key}-${i}`,outcome:i<200?'fail':'pass',durationMs:123,
      ...(i<200?{message:i%20<10?required(fixture.signatures[i%20],'fixture signature').sample:`driver novel ${i%20} ${key}`} :{}),
    }))});
    const start=performance.now();const result=await client.workloads.report(input);const ingest=performance.now()-start;
    if(result.inserted!==10000||result.newTests!==100||result.failures!==200||result.signatures!==20)throw new Error('driver ingest correctness');
    const audit=await client.workloads.auditBatch(result.batch);if(audit.n!==10000||audit.bad!==0)throw new Error('driver durable rows');
    if(round>=0){const m=required(measurements[client.driver],'driver measurements');m.point.push(required(points.toSorted((a,b)=>a-b)[499],'point median'));m.ingest.push(ingest);}
    process.stderr.write(JSON.stringify({round,driver:client.driver,pointMs:points.toSorted((a,b)=>a-b)[499],ingestMs:ingest})+'\n');
  }
}finally{for(const client of clients)await client.db.close();}
const median=(values:number[])=>required(values.toSorted((a,b)=>a-b)[2],'five-run median');
const bun=required(measurements.bun,'Bun measurements');const postgres=required(measurements.postgres,'postgres measurements');
const pointWinner=median(bun.point)<=median(postgres.point)?'bun':'postgres';
const ingestWinner=median(bun.ingest)<=median(postgres.ingest)?'bun':'postgres';
const pointSeparated=Math.max(...bun.point)<Math.min(...postgres.point)||Math.max(...postgres.point)<Math.min(...bun.point);
const ingestSeparated=Math.max(...bun.ingest)<Math.min(...postgres.ingest)||Math.max(...postgres.ingest)<Math.min(...bun.ingest);
const selected=pointSeparated?pointWinner:ingestSeparated?ingestWinner:'bun';
const result={selected,pointSeparated,ingestSeparated,reason:pointSeparated?'Choose the consistently faster case-read driver; overlapping ingest ranges are inconclusive.':ingestSeparated?'Choose the consistently faster ingest driver.':'Neither measurement separates the drivers; prefer the built-in client to avoid a production dependency.',measurements,summary:Object.fromEntries(Object.entries(measurements).map(([driver,value])=>[driver,{pointMedianMs:median(value.point),ingestMedianMs:median(value.ingest),pointRange:[Math.min(...value.point),Math.max(...value.point)],ingestRange:[Math.min(...value.ingest),Math.max(...value.ingest)]}])),check:'Five alternating measured rounds per driver, 1,000 case reads and one durable 10,000-result transaction per round; one unreported warmup round. Drivers use prepared statements and pools of eight. Other candidates are concurrently active.'};
z.string().parse(selected);
await writeFile('driver-choice.json',JSON.stringify(result,null,2)+'\n');await writeFile('selected-driver.txt',selected+'\n');
