import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { idRow } from './schemas';

export type Param = string | number | null;
export type SqlRow = Param[];
export const perf = new AsyncLocalStorage<{ dbMs: number; queries: number }>();
export interface Db {
  dialect: 'sqlite' | 'pg';
  all(sql: string, params?: Param[]): Promise<unknown[]>;
  exec(sql: string, params?: Param[]): Promise<void>;
  bulk(table: string, columns: string[], rows: SqlRow[], conflict?: string): Promise<void>;
  ids(count: number): Promise<number[]>;
  transaction<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
  search(text:string,lo:number,hi:number):Promise<unknown[]>;
  replaceSearch(id:number,folder:number,text:string):Promise<void>;
  lockProject():Promise<void>;
}
export const lockProject=(db:Db)=>db.all(`SELECT seq FROM project WHERE id=1${db.dialect==='pg'?' FOR UPDATE':''}`).then(()=>{});
export function search(db:Db,text:string,lo:number,hi:number){
  const terms=text.trim().split(/\s+/).map(word=>`"${word.replaceAll('"','""')}"`).join(' AND ');
  const sql=db.dialect==='sqlite'
    ?`WITH hits AS (SELECT rowid id,bm25(search_doc) raw_score,text FROM search_doc WHERE search_doc MATCH $1 AND project=1 AND folder BETWEEN $2 AND $3 ORDER BY rank LIMIT 50) SELECT k.id,k.ref_no,k.title,k.folder,-hits.raw_score score,hits.text FROM hits JOIN kase k ON k.id=hits.id ORDER BY hits.raw_score ASC,k.id`
    :`WITH term AS MATERIALIZED (SELECT plainto_tsquery('simple',$1) term), hits AS MATERIALIZED (SELECT s.case_id,ts_rank_cd(s.tsv,term.term)::float8 score FROM search_doc s CROSS JOIN term WHERE s.project=1 AND s.folder BETWEEN $2 AND $3 AND s.tsv @@ term.term ORDER BY score DESC,s.case_id LIMIT 50) SELECT k.id,k.ref_no,k.title,k.folder,hits.score,s.text FROM hits JOIN kase k ON k.id=hits.case_id JOIN search_doc s ON s.case_id=hits.case_id ORDER BY hits.score DESC,k.id`;
  return db.all(sql,[db.dialect==='sqlite'?terms:text,lo,hi]);
}
export async function replaceSearch(db:Db,id:number,folder:number,text:string){
  if(db.dialect==='sqlite'){
    await db.exec('DELETE FROM search_doc WHERE rowid=$1',[id]);await db.exec('INSERT INTO search_doc(rowid,text,project,folder) VALUES($1,$2,1,$3)',[id,text,folder]);
  }else await db.exec('INSERT INTO search_doc(case_id,project,folder,text) VALUES($1,1,$2,$3) ON CONFLICT(case_id) DO UPDATE SET text=excluded.text,folder=excluded.folder',[id,folder,text]);
}
export async function timed<T>(fn: () => T | Promise<T>): Promise<T> {
  const t = performance.now();
  try { return await fn(); }
  finally {
    const stats = perf.getStore();
    if (stats) { stats.dbMs += performance.now() - t; stats.queries++; }
  }
}
export function marks(count: number, start = 1): string {
  return Array.from({ length: count }, (_, i) => `$${i + start}`).join(',');
}
export async function bulkPg(db: Db, table: string, columns: string[], rows: SqlRow[], conflict = ''): Promise<void> {
  for (let start = 0; start < rows.length; start += 1000) {
    const chunk = rows.slice(start, start + 1000);
    const values = chunk.map((_, i) => `(${marks(columns.length, i * columns.length + 1)})`).join(',');
    await db.exec(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${values} ${conflict}`, chunk.flat());
  }
}
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release: () => void = () => {};
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await prev;
    try { return await fn(); } finally { release(); }
  }
}
export async function pgIds(db: Db, count: number): Promise<number[]> {
  return z.array(idRow).parse(await db.all("SELECT nextval('ids') id FROM generate_series(1,$1::int)", [count])).map(x => x.id);
}
export async function openDb(mode = process.env.MODE ?? 'embedded'): Promise<Db> {
  switch (mode) {
    case 'embedded':
      if (process.env.RUNTIME === 'node') return (await import('./sqlite-node')).openSqliteNode();
      return (await import('./sqlite-bun')).openSqliteBun();
    case 'server': return (await import('./db-pg')).openPg(process.env.PG_DRIVER ?? 'bun');
    case 'pglite': return (await import('./db-pglite')).openPglite();
    default: throw new Error(`Unknown store mode ${mode}`);
  }
}
export function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label}`);
  return value;
}
export async function select<S extends z.ZodType>(db: Db, schema: S, sql: string, params: Param[] = []): Promise<z.output<S>[]> {
  return z.array(schema).parse(await db.all(sql, params));
}
export async function one<S extends z.ZodType>(db: Db, schema: S, sql: string, params: Param[] = []): Promise<z.output<S>> {
  return required((await select(db, schema, sql, params))[0], 'database row');
}
