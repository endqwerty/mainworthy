import type { Db } from './db';
export async function openSqliteBun(): Promise<Db> { throw new Error('Bun adapter is excluded from the Node embedded comparison'); }
export async function openPg(): Promise<Db> { throw new Error('PostgreSQL is excluded from the Node embedded comparison'); }
export async function openPglite(): Promise<Db> { throw new Error('PGlite is excluded from the Node embedded comparison'); }
