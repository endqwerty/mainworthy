import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { z } from 'zod';
import { type Db, type Param, marks, timed, Mutex,search,replaceSearch,lockProject } from './db';
import { number } from './schemas';

export async function openSqliteNode(): Promise<Db> {
  const raw = new DatabaseSync(process.env.DB_PATH ?? 'work.db');
  raw.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA cache_size=-65536;');
  const cache = new Map<string, StatementSync>();
  const mutex = new Mutex();
  const stmt = (sql: string) => {
    let q = cache.get(sql);
    if (!q) { q = raw.prepare(sql.replace(/\$(\d+)/g, '?')); cache.set(sql, q); }
    return q;
  };
  const bindings = (sql: string, params: Param[]) => Array.from(sql.matchAll(/\$(\d+)/g), match => {
    const value = params[Number(match[1]) - 1];
    if (value === undefined) throw new Error('Missing SQLite binding');
    return value;
  });
  let next = Math.max(100000000, ...['result','question','decision','test','target','batch','signature','run'].map(table => {
    const row = z.object({ n: number.nullable() }).parse(raw.prepare(`SELECT max(id) n FROM ${table}`).get());
    return row.n ?? 0;
  })) + 1;
  const db: Db = {
    dialect: 'sqlite',
    search:(text,lo,hi)=>search(db,text,lo,hi),replaceSearch:(id,folder,text)=>replaceSearch(db,id,folder,text),lockProject:()=>lockProject(db),
    all: (sql, params = []) => timed(() => stmt(sql).all(...bindings(sql, params))),
    exec: (sql, params = []) => timed(() => { stmt(sql).run(...bindings(sql, params)); }),
    bulk: (table, cols, rows, conflict = '') => timed(() => {
      const q = stmt(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${marks(cols.length)}) ${conflict}`);
      for (const row of rows) q.run(...row);
    }),
    ids: async count => {
      const row=z.object({n:number}).parse((await db.all(`SELECT max(n) n FROM (${['result','question','decision','test','target','batch','signature','run'].map(table=>`SELECT coalesce(max(id),0) n FROM ${table}`).join(' UNION ALL ')})`))[0]);
      next=Math.max(next,row.n+1);return Array.from({length:count},()=>next++);
    },
    transaction: async fn => {
      raw.exec('BEGIN IMMEDIATE');
      try { const out = await fn(db); raw.exec('COMMIT'); return out; }
      catch (error) { raw.exec('ROLLBACK'); throw error; }
    },
    exclusive: fn => mutex.run(fn),
    close: async () => { raw.exec('PRAGMA wal_checkpoint(TRUNCATE)'); raw.close(); },
  };
  return db;
}
