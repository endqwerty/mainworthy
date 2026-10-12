import { readFile,writeFile } from 'node:fs/promises';
const json=async(path:string):Promise<unknown>=>JSON.parse(await readFile(path,'utf8'));
const optional=async(path:string)=>{try{return await json(path);}catch{return{status:'not run'};}};
await writeFile('results.json',JSON.stringify({stack:'TypeScript 7.0.2 on Bun 1.4.3; SQLite embedded, PostgreSQL 18.4 server',mode:{embedded:await json('embedded.json'),server:await json('server.json')},driver:await json('driver-choice.json'),registry:await json('registry-proof.json'),artifact:await json('build-metrics.json'),extras:{node:await optional('node.json'),pglite:await optional('pglite.json'),pgliteSeed:await optional('pglite-seed-info.json')},provisional:true},null,2)+'\n');
