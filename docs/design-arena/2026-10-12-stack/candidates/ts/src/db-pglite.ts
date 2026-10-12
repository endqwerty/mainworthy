import type { PGliteInterface, Transaction } from '@electric-sql/pglite';
import { type Db, bulkPg, pgIds, timed, Mutex,search,replaceSearch,lockProject } from './db';
export async function openPglite(): Promise<Db> {
  const name=process.env.PGLITE_MODULE;
  if(!name)throw new Error('PGLITE_MODULE must name the installed optional PGlite package');
  const pkg:typeof import('@electric-sql/pglite')=await import(name);
  const raw=await pkg.PGlite.create(process.env.PGLITE_PATH??'pglite-data',{relaxedDurability:false});
  const mutex=new Mutex();
  const wrap=(pg:PGliteInterface|Transaction):Db=>{
    const db:Db={dialect:'pg',
      search:(text,lo,hi)=>search(db,text,lo,hi),replaceSearch:(id,folder,text)=>replaceSearch(db,id,folder,text),lockProject:()=>lockProject(db),
      all:(sql,params=[])=>timed(async()=>Array.from((await pg.query(sql,params)).rows)),
      exec:async(sql,params=[])=>{await timed(()=>pg.query(sql,params));},
      bulk:(table,cols,rows,conflict)=>bulkPg(db,table,cols,rows,conflict),
      ids:count=>pgIds(db,count),transaction:fn=>'transaction'in pg?pg.transaction(tx=>fn(wrap(tx))):Promise.reject(new Error('nested PGlite transaction')),
      exclusive:fn=>mutex.run(fn),close:()=>raw.close(),
    };return db;
  };
  const db=wrap(raw);await db.exec('SET synchronous_commit=on');return db;
}
