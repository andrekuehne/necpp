#!/usr/bin/env python3
"""Print reproducible report tables from raw benchmark observations."""
import json, pathlib, statistics, sys
p=pathlib.Path(sys.argv[1] if len(sys.argv)>1 else 'bench/ring-far-field/evidence')
rows={runtime:[json.loads(line) for line in (p/(runtime+'.ndjson')).read_text().splitlines()] for runtime in ['native','wasm']}
cases=['regular4','regular8','regular16','sunflower256','free4','heights4','tilted4']
# Fail before rendering a report if observations are incomplete or miss a gate.
import math
rounds = json.loads((p / 'metadata.json').read_text())['rounds']
for runtime, observations in rows.items():
    assert len(observations) == len(cases) * rounds * 2, runtime
    for name in cases:
        for steer in (0, 1):
            subset = [r for r in observations if r['case'] == name and r['steer'] == steer]
            assert sorted(r['round'] for r in subset) == list(range(rounds))
    for r in observations:
        assert all(math.isfinite(v) for v in r.values() if isinstance(v, (float, int)))
        assert max(r['errorTheta'], r['errorPhi'], r['componentErrorTheta'],
                   r['componentErrorPhi'], r['interpolationError'],
                   abs(r['closureDelta'])) <= 1e-7
        assert f"{r['closureDirect']:.9f}" == f"{r['closureRing']:.9f}"
        images = 1 if r['case'] == 'free4' else 2
        assert r['contributions'] == r['segments'] * r['nt'] * r['np'] * images
def select(runtime,name,steer=None):return [r for r in rows[runtime] if r['case']==name and (steer is None or r['steer']==steer)]
def med(rs,k):return statistics.median(r[k] for r in rs)
def table(header,body):return '| '+' | '.join(h.replace('|', r'\|') for h in header)+' |\n| '+' | '.join(['---']*len(header))+' |\n'+'\n'.join('| '+' | '.join(map(str,r))+' |' for r in body)+'\n'
tables={}
b=[]
for name in cases:
 r=select('wasm',name)[0]
 b.append([name,r['segments'],f"{r['nt']} × {r['np']}",f"{r['nt']*r['np']:,}",f"{r['contributions']:,}"])
tables['sizes']=table(['Case','Segments','θ × φ','Directions','segmentDirectionContributions'],b)
b=[]
for name in cases:
 cold=select('wasm',name,0);warm=select('wasm',name,1)
 fc,sc,fr,sr=med(cold,'directMs'),med(cold,'solveMs'),med(warm,'directMs'),med(warm,'solveMs')
 b.append([name,*[f'{med(cold,k):.3f}' for k in ['fillMs','factorMs','solveMs','directMs']],f'{100*fc/(med(cold,"prepareMs")+sc+fc):.2f}%',f'{sr:.3f}',f'{fr:.3f}',f'{100*fr/(sr+fr):.2f}%'])
tables['profile']=table(['Case','Fill ms','Factor ms','Cold solve ms','Cold field ms','Cold FF share','Re-solve ms','Re-field ms','Re-steer FF share'],b)
b=[]
for name in cases:
 rs=select('wasm',name);r=rs[0];lo=min(x['ringDirections'] for x in rs);hi=max(x['ringDirections'] for x in rs);images=1 if name=='free4' else 2
 b.append([name,f'{lo:,}–{hi:,}' if lo!=hi else f'{lo:,}',(f'{lo*r["segments"]*images:,}–{hi*r["segments"]*images:,}' if lo != hi else f'{lo*r["segments"]*images:,}'),f'{r["nt"]*r["np"]/hi:.2f}×',max(x['maxL'] for x in rs),max(x['maxSegmentExtra'] for x in rs),max(x['fallbackRings'] for x in rs)])
tables['counts']=table(['Case','Ring directions incl. scouts','Ring segment/image contributions','Direction reduction (minimum)','Max L','Max L_seg','Fallback rings'],b)
b=[]
for name in cases:
 for runtime in ['native','wasm']:
  rs=select(runtime,name,1);d,t,r=[med(rs,k) for k in ['directMs','tileMs','ringMs']]
  b.append([name,runtime,f'{d:.3f}',f'{t:.3f}',f'{r:.3f}',f'{d/r:.2f}×',f'{t/r:.2f}×'])
tables['speed']=table(['Case','Runtime','Stateful direct ms','Tile direct ms','Ring ms','Vs stateful','Vs tile'],b)
b=[]
for name in cases:
 rs=select('native',name)+select('wasm',name)
 et=max(rs,key=lambda x:x['errorTheta']);ep=max(rs,key=lambda x:x['errorPhi'])
 b.append([name,f'{et["errorTheta"]:.3e}',f'{ep["errorPhi"]:.3e}',f'{max(r["interpolationError"] for r in rs):.3e}',f'{max(abs(r["closureDelta"]) for r in rs):.3e}',f'{et["worstThetaRingDeg"]:.6f}°',f'{ep["worstPhiRingDeg"]:.6f}°' if ep['errorPhi'] else 'all zero'])
tables['accuracy']=table(['Case','Max ΔEθ / vector peak','Max ΔEφ / vector peak','Ring vs tile / peak','Max |Δclosure|','Worst θ ring (Eθ)','Worst θ ring (Eφ)'],b)
b=[]
for name in cases:
 rs=select('native',name)+select('wasm',name)
 b.append([name,f'{min(r["closureDirect"] for r in rs):.9f}–{max(r["closureDirect"] for r in rs):.9f}',f'{max(r["componentErrorTheta"] for r in rs):.3e}',f'{max(r["componentErrorPhi"] for r in rs):.3e}',f'{max(r["tileOracleError"] for r in rs):.3e}'])
tables['closure']=table(['Case','Direct Pflux / PNEC range','ΔEθ / Eθ peak','ΔEφ / Eφ peak','Direct tile vs stateful / vector peak'],b)
for key,value in tables.items():print(f'<!-- BEGIN {key} -->\n{value}<!-- END {key} -->\n')
if len(sys.argv)>2:
 import re
 report=pathlib.Path(sys.argv[2]);s=report.read_text()
 for key,value in tables.items():
  s,n=re.subn(r'<!-- BEGIN '+key+r' -->.*?<!-- END '+key+r' -->','<!-- BEGIN '+key+' -->\n'+value+'<!-- END '+key+' -->',s,flags=re.S)
  assert n==1,key
 report.write_text(s)
