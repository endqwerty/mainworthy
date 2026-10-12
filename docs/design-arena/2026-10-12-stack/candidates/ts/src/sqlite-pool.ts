import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { required } from './db';
import { invoke } from './invoke';
import { registry } from './registry';

type Result=Awaited<ReturnType<typeof invoke>>;
const responseSchema=z.union([
  z.object({ready:z.literal(true)}),
  z.object({id:z.number(),error:z.string()}),
  z.object({id:z.number(),result:z.object({value:z.unknown(),operationMs:z.number(),dbMs:z.number(),queries:z.number(),waitMs:z.number()})}),
]);
export async function sqlitePool(readers=4) {
  const workers:Worker[]=[];
  const pending=new Map<number,{resolve:(value:Result)=>void;reject:(error:Error)=>void}>();
  let id=0;let cursor=0;
  for(let i=0;i<=readers;i++){
    const worker=new Worker(new URL(process.env.RUNTIME==='node'?'./node-worker.js':'./sqlite-worker.ts',import.meta.url));
    workers.push(worker);
    await new Promise<void>((resolve,reject)=>{
      worker.on('message',(raw:unknown)=>{
        const value=responseSchema.parse(raw);
        if('ready'in value){resolve();return;}
        const task=pending.get(value.id);if(!task)throw new Error('unknown worker response');pending.delete(value.id);
        if('error'in value)task.reject(new Error(value.error));else task.resolve(value.result);
      });
      worker.on('error',error=>{const failure=error instanceof Error?error:new Error(String(error));reject(failure);for(const task of pending.values())task.reject(failure);pending.clear();});
    });
  }
  return {
    execute:(path:string,method:string,raw:unknown):Promise<Result>=>{
      const writer=(path.startsWith('/api/')&&registry.find(op=>op.name===path.slice(5))?.effect==='write')||path==='/rollback'||path==='/counts'||path.startsWith('/audit/');
      const worker=required(workers[writer?0:1+(cursor++%readers)],'SQLite worker');const requestId=id++;
      return new Promise((resolve,reject)=>{pending.set(requestId,{resolve,reject});worker.postMessage({id:requestId,path,method,raw});});
    },
    close:async()=>{await Promise.all(workers.map(worker=>worker.terminate()));},
  };
}
