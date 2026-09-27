#!/usr/bin/env python3
"""Run serially, fail on missing cases/accuracy gates, retain raw observations."""
import argparse, hashlib, json, pathlib, platform, subprocess, time
p=argparse.ArgumentParser();p.add_argument('--native',required=True);p.add_argument('--wasm',required=True);p.add_argument('--out',required=True);p.add_argument('--rounds',type=int,default=3);a=p.parse_args()
out=pathlib.Path(a.out);out.mkdir(parents=True,exist_ok=True)
root=pathlib.Path(__file__).resolve().parents[2]
def command(*args):return subprocess.check_output(args,text=True).strip()
def sha(path):return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
meta={'date':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'commit':command('git','rev-parse','HEAD'),'platform':platform.platform(),'cpu':next(x.split(':')[1].strip() for x in pathlib.Path('/proc/cpuinfo').read_text().splitlines() if x.startswith('model name')),'node':command('node','--version'),'g++':command('g++','--version').splitlines()[0],'rounds':a.rounds,'nativeSha256':sha(a.native),'benchWasmSha256':sha(pathlib.Path(a.wasm).with_suffix('.wasm')),'packageWasmSha256':sha(root/'packages/necpp-wasm/dist/nec2pp.wasm'),'wasmCompiler':'Emscripten 4.0.7; see build.py for exact flags','protocol':'3 fresh models; one cold + one retained voltage RHS per model; scalar; explicit geometry; serial execution; module/process startup excluded'}
meta['workingTreeDirty']=bool(command('git','status','--porcelain'))
meta['sourceSha256']={str(p.relative_to(root)):sha(p) for p in sorted((root/'src').glob('nec*field*')) if p.suffix in ['.h','.cpp']}
(out/'metadata.json').write_text(json.dumps(meta,indent=2)+'\n')
for runtime,cmd in [('native',[a.native]),('wasm',['node',a.wasm])]:
 with (out/(runtime+'.ndjson')).open('w') as f:
  for name in ['regular4','regular8','regular16','sunflower256','free4','heights4','tilted4']:
   print(runtime,name,flush=True)
   result=subprocess.run([*cmd,name,str(a.rounds)],text=True,capture_output=True,timeout=900,check=True)
   rows=[json.loads(x) for x in result.stdout.splitlines()]
   assert len(rows)==a.rounds*2 and all(x['case']==name for x in rows)
   for row in rows:f.write(json.dumps(row)+'\n')
   f.flush()
