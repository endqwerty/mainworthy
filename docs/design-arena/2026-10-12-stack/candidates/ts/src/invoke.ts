import { perf } from './db';
import { registry } from './registry';
import { Workloads } from './workloads';

export async function invoke(ctx: Workloads, path: string, method: string, raw: unknown) {
  const stats={dbMs:0,queries:0};const start=performance.now();let waitMs=0;
  return perf.run(stats,async()=>{
    const value=await ctx.db.exclusive(async()=>{
      waitMs=performance.now()-start;
      if(path==='/health')return ctx.get({ref:1});
      if(path==='/fixtures')return ctx.fixtures();
      if(path==='/counts')return ctx.counts();
      if(path.startsWith('/audit/'))return ctx.auditBatch(Number(path.split('/')[2]));
      if(path==='/rollback')return ctx.rollbackProof();
      if(method!=='POST')throw new Error('POST required');
      if(path.startsWith('/api/')){
        const op=registry.find(op=>op.name===path.slice(5));if(!op)throw new Error('Unknown operation');return op.invoke(ctx,raw);
      }
      return ctx.dispatch(path.slice(7),raw);
    });
    return {value,operationMs:performance.now()-start,dbMs:stats.dbMs,queries:stats.queries,waitMs};
  });
}
