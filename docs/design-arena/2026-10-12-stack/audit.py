#!/usr/bin/env python3
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import selectors
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path('/home/endqwerty/.cache/mainworthy-arena/stack')
OUT = Path('/home/endqwerty/.cache/mainworthy-arena/judge/stack')
name = sys.argv[1]
CANDIDATE = Path(sys.argv[2]) if len(sys.argv)>2 else ROOT/name
label = sys.argv[3] if len(sys.argv)>3 else name
folder = OUT / 'audit' / label
folder.mkdir(parents=True, exist_ok=True)
db = folder / 'work.db'
subprocess.run(['cp', '--reflink=auto', str(ROOT / 'seed.db'), str(db)], check=True)
port = {'ts': 30581, 'go': 30582, 'rust': 30583}[name]
url = f'http://127.0.0.1:{port}'
env = dict(os.environ)
env.update(DB_PATH=str(db), MODE='embedded', RUNTIME='bun', PORT=str(port), MAINWORTHY_DB=str(db), MAINWORTHY_MODE='embedded', CB_DB=str(db), CB_MODE='embedded')
binary = CANDIDATE / ('mainworthy-cgo' if name == 'go' else 'target/release/mainworthy-rust-spike')
cmd = {'ts': ['bun', str(CANDIDATE / 'dist/server.js'), 'serve'],
       'go': [str(binary), 'serve', '--db', str(db), '--addr', f'127.0.0.1:{port}'],
       'rust': [str(binary), 'serve', 'embedded', str(db), str(port)]}[name]
prefix = {'ts': '/api/', 'go': '/ops/', 'rust': '/op/'}[name]
source_files=list(CANDIDATE.glob('src/*'))+list(CANDIDATE.glob('*.go'))
evidence = {'candidate': name, 'root':str(CANDIDATE), 'checks': {}, 'source_hashes': {str(p.relative_to(CANDIDATE)): hashlib.sha256(p.read_bytes()).hexdigest() for p in source_files if p.is_file()}}

def sql(q, args=()):
    conn = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(q, args)]
    finally:
        conn.close()

def snapshot():
    out = {t: sql(f'SELECT count(*) n FROM {t}')[0]['n'] for t in ['version','command','question','decision','result','test','signature','batch','target','run']}
    out['seq'] = sql('SELECT seq FROM project WHERE id=1')[0]['seq']
    return out

def delta(a,b):
    return {k:b[k]-a[k] for k in a}

def http(path, data=None):
    req = urllib.request.Request(url+path, data=None if data is None else json.dumps(data).encode(), headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=45) as res:
            return res.status, json.load(res)
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read())

def get(ref=1):
    code, out = http(prefix+'get', {'ref_no' if name=='rust' else 'ref':ref})
    assert code == 200, out
    return out

def body_of(out):
    return out['body']

def head(out):
    return out['case']['head_no'] if name=='rust' else out['head' if name=='go' else 'head_no']

def save_input(command, base=None, title='judge text with evidence', ref=1):
    body = body_of(get(ref)); body['title'] = title
    args = {'command' if name=='go' else 'cmd':command, 'ref_no' if name=='rust' else 'ref':ref, 'body':body}
    if base is not None: args['base_no' if name=='rust' else 'base']=base
    return args

log = (folder/'server.log').open('w')
child = subprocess.Popen(cmd, env=env, cwd=CANDIDATE, stdout=log, stderr=log)
try:
    for _ in range(100):
        if child.poll() is not None: raise RuntimeError('Server exited; see server.log')
        try:
            if http('/health')[0] == 200: break
        except OSError: pass
        time.sleep(.05)
    else: raise TimeoutError('Server not ready')

    code, document = http('/openapi.json')
    assert code==200 and document['openapi']=='3.1.0'
    assert len(document['paths'])==3
    (folder/'openapi.json').write_text(json.dumps(document,indent=2)+'\n')
    initial = get()
    assert body_of(initial)['title']==sql('SELECT title FROM kase WHERE id=1')[0]['title']
    paths = {'ts':('/bench/folder','/bench/history','/bench/queue'), 'go':('/work/W2','/work/W6','/work/W8'), 'rust':('/bench/w2','/bench/w6','/bench/w8')}[name]
    folder_in = {'Folder':21,'Cursor':0} if name=='go' else {'folder':21,'cursor':0}
    code, rows = http(paths[0],folder_in)
    items=rows['Items' if name=='go' else 'items']
    idkey='ID' if name=='go' else 'id'
    assert code==200 and [r[idkey] for r in items] == [r['id'] for r in sql('SELECT id FROM kase WHERE project=1 AND folder=21 AND rank>0 ORDER BY rank LIMIT 50')]
    glyphs=0
    for row in items:
        tests=sql('SELECT t.id,(SELECT r.outcome FROM result r WHERE r.project=1 AND r.test=t.id ORDER BY seq DESC,ord DESC LIMIT 1) outcome FROM test t WHERE project=1 AND case_id=? ORDER BY id',(row[idkey],))
        if name=='ts': actual=[x['outcome'] for x in row['last']]; count=row['linkedTests']
        elif name=='go': actual=[x['Outcome'] for x in row['Last']]; count=row['Tests']
        else: actual=row['last_outcomes']; count=row['test_count']
        assert count==len(tests) and sorted(actual)==sorted(x['outcome'] for x in tests)
        glyphs+=len(tests)
    code, recent=http(paths[1],{'Test' if name=='go' else 'test':1})
    assert code==200
    history=recent['Items' if name=='go' else 'items']
    assert [r[idkey] for r in history]==[r['id'] for r in sql('SELECT id FROM result WHERE project=1 AND test=1 ORDER BY seq DESC,ord DESC LIMIT 20')]
    code, queue=http(paths[2],{})
    assert code==200
    items=queue['Items' if name=='go' else 'items']
    assert [r[idkey] for r in items]==[r['id'] for r in sql("SELECT id FROM question WHERE project=1 AND state='open' ORDER BY owner,rank LIMIT 50")]
    evidence['checks']['read_sql_oracles']={'pass':True,'folder_rows':50,'glyphs_checked':glyphs,'history_rows':20,'queue_rows':50}
    search_path={'ts':'/bench/search','go':'/work/W3','rust':'/bench/w3'}[name]
    search_args={'ts':{'text':'token receipt','area':1},'go':{'Text':'token receipt','Area':1},'rust':{'query':'token receipt','area':1}}[name]
    status,search=http(search_path,search_args)
    hits=search['Items' if name=='go' else 'items']
    assert status==200 and 0<len(hits)<=50,(status,search)
    scores=[]
    for row in hits:
        ident=row[idkey]
        stored=sql('SELECT text,folder FROM search_doc WHERE rowid=?',(ident,))[0]
        assert 21<=stored['folder']<=44 and all(t in stored['text'].lower() for t in ['token','receipt'])
        scores.append(row['Relevance' if name=='go' else 'score'])
    assert scores==sorted(scores,reverse=name!='go')
    evidence['checks']['and_search_and_area']={'pass':True,'rows':len(hits),'rank_order_checked':True}

    before=snapshot()
    original_head=head(get())
    stale=save_input('judge-stale',original_head+7)
    status,error=http(prefix+'propose',stale)
    assert status>=400 and snapshot()==before, (status,error)
    evidence['checks']['stale_base']={'pass':True,'status':status,'error':error,'delta':delta(before,snapshot())}
    valid=save_input('judge-concurrent-replay',original_head)
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        results=list(pool.map(lambda _:http(prefix+'propose',valid),range(2)))
    assert all(status==200 for status,_ in results) and results[0][1]==results[1][1], results
    after=snapshot(); changed=delta(before,after)
    assert all(changed[t]==1 for t in ['command','version','question','decision','seq']),changed
    evidence['checks']['concurrent_command_replay']={'pass':True,'responses':results,'delta':changed}
    missing=save_input('judge-missing-base',title='judge overwrite without a base')
    before=snapshot(); status,out=http(prefix+'propose',missing); after=snapshot()
    evidence['checks']['missing_base']={'protected':status>=400,'status':status,'response':out,'delta':delta(before,after)}

    current=head(get()); before=snapshot()
    commands=[save_input('judge-distinct-'+str(i),current,title='judge concurrent '+str(i)) for i in range(2)]
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        results=list(pool.map(lambda x:http(prefix+'propose',x),commands))
    assert sum(status==200 for status,_ in results)==1, results
    assert all(delta(before,snapshot())[t]==1 for t in ['seq','command','version','question','decision'])
    evidence['checks']['concurrent_stale_edits']={'pass':True,'statuses':[r[0] for r in results]}

    tests=sql('SELECT key FROM test WHERE id BETWEEN 1 AND 9900 ORDER BY id')
    sigs=sql('SELECT sample FROM signature ORDER BY id LIMIT 10')
    rows=[]
    for i in range(10000):
        row={'key':tests[i]['key'] if i<9900 else 'judge-new-key-'+str(i),'outcome':'fail' if i<200 else 'pass','durationMs':17}
        if i<200:
            group=i%20
            row['message']=(('sig'+str(group+1)) if name=='go' else sigs[group]['sample']) if group<10 else 'judge novel failure '+str(group)
        rows.append(row)
    report={'batch_key' if name=='rust' else 'key':'judge-report', 'commit_sha' if name=='rust' else 'commit':'judge-commit', 'results':rows}
    before=snapshot(); status,out=http(prefix+'report',report); after=snapshot()
    assert status==200,(status,out)
    changes=delta(before,after)
    assert all(changes[k]==v for k,v in {'result':10000,'test':100,'signature':10,'seq':1,'batch':1,'target':1,'run':1,'question':20}.items()),changes
    bid=out['batch_id' if name=='rust' else 'batch']
    audit=sql("SELECT count(*) n, sum(CASE WHEN r.outcome='fail' THEN 1 ELSE 0 END) failures, count(DISTINCT r.signature) signatures, sum(CASE WHEN r.basis='assumed' THEN 1 ELSE 0 END) assumed, sum(CASE WHEN r.basis='unresolved' THEN 1 ELSE 0 END) unresolved, sum(CASE WHEN (t.case_id IS NOT NULL AND (r.basis!='assumed' OR r.basis_case!=t.case_id OR r.basis_version!=k.head_no OR r.basis_case IS NULL OR r.basis_version IS NULL)) OR (t.case_id IS NULL AND (r.basis!='unresolved' OR r.basis_case IS NOT NULL OR r.basis_version IS NOT NULL)) THEN 1 ELSE 0 END) bad FROM result r JOIN test t ON t.id=r.test LEFT JOIN kase k ON k.id=t.case_id WHERE r.batch=?",(bid,))[0]
    assert audit=={'n':10000,'failures':200,'signatures':20,'assumed':9900,'unresolved':100,'bad':0},audit
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        replays=list(pool.map(lambda _:http(prefix+'report',report),range(2)))
    assert all(s==200 for s,_ in replays) and snapshot()==after,replays
    evidence['checks']['report_and_replay']={'pass':True,'delta':changes,'sql':audit,'replays':replays}

    report['key' if name!='rust' else 'batch_key']='judge-invalid-report'
    report['results'][-1]['outcome']='not-an-outcome'
    status,error=http(prefix+'report',report)
    assert status>=400 and snapshot()==after,(status,error)
    evidence['checks']['invalid_report_no_writes']={'pass':True,'status':status}
    evidence['completed']=True
finally:
    child.terminate()
    try:child.wait(timeout=8)
    except subprocess.TimeoutExpired:child.kill();child.wait()
    log.close()
    (folder/'audit.json').write_text(json.dumps(evidence,indent=2)+'\n')
    for suffix in ['','-wal','-shm']:
        Path(str(db)+suffix).unlink(missing_ok=True)
print(json.dumps(evidence,indent=2))
