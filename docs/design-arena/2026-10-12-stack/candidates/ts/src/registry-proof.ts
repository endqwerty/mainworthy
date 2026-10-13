import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { getOutput } from './schemas';
import { openapi } from './registry';

const env:Record<string,string>={};
for(const [key,value]of Object.entries(process.env))if(value!==undefined)env[key]=value;
const transport=new StdioClientTransport({command:'bun',args:['dist/server.js','mcp'],env:{...env,MODE:'embedded',DB_PATH:'work.db'},stderr:'pipe'});
let stderr='';transport.stderr?.on('data',chunk=>{stderr+=String(chunk);});
const client=new Client({name:'mainworthy-registry-proof',version:'0.1.0'});
try{
  await client.connect(transport);
  const tools=await client.listTools();
  if(tools.tools.map(x=>x.name).toSorted().join(',')!=='get,propose,report')throw new Error('tools/list registry mismatch');
  const result=await client.callTool({name:'get',arguments:{ref:1}});
  if(result.isError)throw new Error(JSON.stringify(result));
  const value=getOutput.parse(result.structuredContent);
  const cli=spawnSync('bun',['dist/server.js','get','--json','{"ref":1}'],{env:{...env,MODE:'embedded',DB_PATH:'work.db'},encoding:'utf8'});
  if(cli.status!==0)throw new Error(cli.stderr);
  const cliValue=getOutput.parse(JSON.parse(cli.stdout));
  if(JSON.stringify(cliValue)!==JSON.stringify(value))throw new Error('CLI and MCP result mismatch');
  const help=spawnSync('bun',['dist/server.js','--help'],{encoding:'utf8'});
  if(help.status!==0||!tools.tools.every(tool=>help.stdout.includes(tool.name)))throw new Error('generated CLI help');
  const document=openapi();if(Object.keys(document.paths).length!==3)throw new Error('OpenAPI routes');
  await writeFile('mcp-tools-list.json',JSON.stringify(tools,null,2)+'\n');
  await writeFile('mcp-tools-call.json',JSON.stringify(result,null,2)+'\n');
  await writeFile('openapi.json',JSON.stringify(document,null,2)+'\n');
  await writeFile('cli-help.txt',help.stdout);
  await writeFile('registry-proof.json',JSON.stringify({sdk:'@modelcontextprotocol/sdk',sdkVersion:'1.32.1',protocolRevision:LATEST_PROTOCOL_VERSION,supportedProtocolRevisions:SUPPORTED_PROTOCOL_VERSIONS,toolListBytes:Buffer.byteLength(JSON.stringify(tools)),tools:tools.tools.map(x=>x.name),call:{name:'get',ref:value.ref_no,version:value.head_no},cliMatchesMcp:true,openapi:'3.1.0',generatedRoutes:Object.keys(document.paths),check:'tools/list and tools/call through official SDK client on actual stdio; CLI result identical'},null,2)+'\n');
}catch(error){throw new Error(`${String(error)}\n${stderr}`);}finally{await client.close();}
