import { spawnSync } from 'node:child_process';
import { mkdir,stat,readdir,readFile,rm,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

await rm('dist',{recursive:true,force:true});await mkdir('dist');
const start=performance.now();
for(const args of [
  ['build','src/main.ts','--target=bun','--minify','--outfile','dist/server.js'],
  ['build','src/sqlite-worker.ts','--target=bun','--minify','--outfile','dist/sqlite-worker.ts'],
  ['build','src/main.ts','src/sqlite-worker.ts','--compile','--minify','--outfile','dist/mainworthy'],
]){
  const result=spawnSync('bun',args,{encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr);process.stderr.write(result.stdout+result.stderr);
}
const nodeBuild=await Bun.build({entrypoints:['src/main.ts','src/sqlite-worker.ts','src/bench.ts'],target:'node',minify:true,outdir:'dist/node-build',plugins:[{name:'node-embedded-only',setup(builder){builder.onResolve({filter:/(?:^|\/)(?:sqlite-bun|db-pg|db-pglite)$/},()=>({path:resolve('src/node-disabled.ts')}));}}]});
if(!nodeBuild.success)throw new Error(nodeBuild.logs.join('\n'));
await writeFile('dist/node.js',await readFile('dist/node-build/main.js'));
await writeFile('dist/node-worker.js',await readFile('dist/node-build/sqlite-worker.js'));
await writeFile('dist/node-bench.js',await readFile('dist/node-build/bench.js'));
const buildMs=performance.now()-start;
let lines=0;
for(const file of await readdir('src'))if(file.endsWith('.ts'))lines+=(await readFile(`src/${file}`,'utf8')).trimEnd().split('\n').length;
lines+=(await readFile('run.sh','utf8')).trimEnd().split('\n').length;
const result={buildMs,compiledBinaryBytes:(await stat('dist/mainworthy')).size,containerBundleBytes:(await stat('dist/server.js')).size+(await stat('dist/sqlite-worker.ts')).size,nodeBundleBytes:(await stat('dist/node.js')).size+(await stat('dist/node-worker.js')).size,linesOfCode:lines,versions:{bun:Bun.version,node:spawnSync('node',['--version'],{encoding:'utf8'}).stdout.trim(),typescript:'7.0.2',zod:'4.6.6',mcp:'1.32.1',postgres:'3.4.9',xml:'5.11.2'},directRuntimeDependencies:4,directBuildDependencies:3,check:'Clean dist rebuild including reader/writer worker; no dependency reinstall in build timing'};
await writeFile('build-metrics.json',JSON.stringify(result,null,2)+'\n');
