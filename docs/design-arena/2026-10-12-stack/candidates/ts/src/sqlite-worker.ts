import { parentPort } from 'node:worker_threads';
import { z } from 'zod';
import { openDb, required } from './db';
import { Workloads } from './workloads';
import { invoke } from './invoke';

const port=required(parentPort??undefined,'worker parent port');
const db=await openDb('embedded');const ctx=new Workloads(db);await ctx.init();
const messageSchema=z.object({id:z.number().int(),path:z.string(),method:z.string(),raw:z.unknown()});
port.on('message',async(raw:unknown)=>{
  const message=messageSchema.parse(raw);
  try { port.postMessage({id:message.id,result:await invoke(ctx,message.path,message.method,message.raw)}); }
  catch(error) { port.postMessage({id:message.id,error:error instanceof Error?error.message:String(error)}); }
});
port.postMessage({ready:true});
