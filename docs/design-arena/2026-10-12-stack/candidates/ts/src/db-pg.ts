import { SQL } from 'bun';
import postgres from 'postgres';
import { type Db, type Param, bulkPg, pgIds, timed,search,replaceSearch,lockProject } from './db';

const url = process.env.PG_URL ?? 'postgres://postgres@127.0.0.1:54329/cb_ts';
export async function openPg(driver: string): Promise<Db> {
  const target=new URL(url);
  if(target.pathname!=='/cb_ts'||target.hostname!=='127.0.0.1'||target.port!=='54329')throw new Error('Arena PostgreSQL adapter is restricted to cb_ts on the supplied loopback server');
  if (driver === 'postgres') {
    const sql = postgres(url, { max: 8, prepare: true, idle_timeout: 30, connection: { synchronous_commit: 'on' }, onnotice: () => {} });
    const wrap = (query: (text: string, values: Param[]) => Promise<unknown[]>, transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>): Db => {
      const db: Db = {
        dialect: 'pg', all: (text, values = []) => timed(() => query(text, values)),
        search:(text,lo,hi)=>search(db,text,lo,hi),replaceSearch:(id,folder,text)=>replaceSearch(db,id,folder,text),lockProject:()=>lockProject(db),
        exec: async (text, values = []) => { await timed(() => query(text, values)); },
        bulk: (table, cols, rows, conflict) => bulkPg(db, table, cols, rows, conflict),
        ids: count => pgIds(db, count), transaction, exclusive: fn => fn(), close: async () => { await sql.end(); },
      };
      return db;
    };
    const db = wrap(async (q, p) => Array.from(await sql.unsafe(q, p,{prepare:true})), async fn => (await sql.begin(async tx => {
      const inner = wrap(async (q, p) => Array.from(await tx.unsafe(q, p,{prepare:true})), async () => { throw new Error('nested transaction'); });
      return { value: await fn(inner) };
    })).value);
    await db.all('SELECT 1');
    return db;
  }
  const sql = new SQL(url, { max: 8, prepare: true, idleTimeout: 30, connectionTimeout: 5 });
  const wrap = (raw: SQL): Db => {
    const db: Db = {
      dialect: 'pg', all: (text, values = []) => timed(async () => Array.from(await raw.unsafe(text, values))),
      search:(text,lo,hi)=>search(db,text,lo,hi),replaceSearch:(id,folder,text)=>replaceSearch(db,id,folder,text),lockProject:()=>lockProject(db),
      exec: async (text, values = []) => { await timed(() => raw.unsafe(text, values)); },
      bulk: (table, cols, rows, conflict) => bulkPg(db, table, cols, rows, conflict),
      ids: count => pgIds(db, count), transaction: fn => raw.begin(tx => fn(wrap(tx))),
      exclusive: fn => fn(), close: async () => { await sql.close(); },
    };
    return db;
  };
  const db = wrap(sql);
  await db.all('SELECT 1');
  return db;
}
