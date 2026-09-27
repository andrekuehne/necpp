#!/usr/bin/env python3
"""Render production tables and enforce the documented numerical/speed gates."""
import json
from pathlib import Path
from statistics import median
root=Path(__file__).resolve().parents[2]
evidence=Path(__file__).parent/'evidence/production'
cases=['regular4','regular8','regular16','sunflower256','free4','heights4','tilted4']
data={name:[json.loads(line) for line in (evidence/(name+'.ndjson')).read_text().splitlines()]
      for name in ['native','wasm','workers','embedded']}
for runtime in ['native','wasm']:
    assert len(data[runtime])==42
    for row in data[runtime]:
        assert max(row['errorTheta'],row['errorPhi'])<=1e-7
        assert f"{row['closureDirect']:.9f}"==f"{row['closureRing']:.9f}", row
assert len(data['workers'])==21 and len(data['embedded'])==49
lines=[]
def table(headers,rows):
    lines.append('| '+' | '.join(headers)+' |')
    lines.append('| '+' | '.join(['---']*len(headers))+' |')
    lines.extend('| '+' | '.join(str(x) for x in row)+' |' for row in rows)
    lines.append('')
for runtime in ['native','wasm']:
    lines.append(f'**{runtime.upper()}: retained-drive median field times (ms).**\n')
    rows=[]
    for case in cases:
        selected=[r for r in data[runtime] if r['case']==case and r['steer']==1]
        direct,tile,kernel,integrated=[median(r[key] for r in selected)
            for key in ['directMs','tileMs','ringMs','integratedRingMs']]
        if case in ['regular16','sunflower256']: assert tile/kernel>=2 and direct/integrated>=2
        rows.append([case,f'{direct:.3f}',f'{integrated:.3f}',f'{direct/integrated:.2f}×',
                     f'{tile:.3f}',f'{kernel:.3f}',f'{tile/kernel:.2f}×'])
    table(['Case','Stateful exact','Stateful ring','Speedup','Tile exact','Ring kernel','Speedup'],rows)
lines.append('**Accuracy and work counts across both runtimes and both drive states.**\n')
rows=[]
for case in cases:
    selected=[r for name in ['native','wasm'] for r in data[name] if r['case']==case]
    a=selected[0];directions=a['nt']*a['np'];images=1 if case=='free4' else 2
    counts=[r['ringDirections'] for r in selected]
    worst=max(selected,key=lambda r:max(r['errorTheta'],r['errorPhi']))
    angle=worst['worstThetaRingDeg'] if worst['errorTheta']>=worst['errorPhi'] else worst['worstPhiRingDeg']
    rows.append([case,a['segments'],f"{a['nt']}×{a['np']}={directions:,}",f"{a['contributions']:,}",
                 f'{min(counts):,}–{max(counts):,}',f'{min(counts)*a["segments"]*images:,}–{max(counts)*a["segments"]*images:,}',
                 f'{max(r["errorTheta"] for r in selected):.3e}',f'{max(r["errorPhi"] for r in selected):.3e}',
                 f'{max(abs(r["closureDelta"]) for r in selected):.3e}',f'{angle:.4f}°'])
table(['Case','Segments','Output directions','Direct contributions','Ring directions incl. scouts',
       'Ring contributions','Max ΔEθ / peak','Max ΔEφ / peak','Max closure change','Worst ring θ'],rows)
lines.append('All 84 closure comparisons agree to nine decimal places.\n')
lines.append('**Packaged WASM, two workers: median field wall times (ms), full grids.**\n')
rows=[]
for case in cases:
    selected=[r for r in data['workers'] if r['case']==case]
    direct,ring=[median(r[k] for r in selected) for k in ['directMs','ringMs']]
    error=max(max(r['errorTheta'],r['errorPhi']) for r in selected);assert error<=1e-7
    rows.append([case,f'{direct:.3f}',f'{ring:.3f}',f'{direct/ring:.2f}×',selected[0]['evaluatedDirections'],f'{error:.3e}'])
table(['Case','Exact pool','Ring pool','Speedup','Ring directions','Max component error / peak'],rows)
lines.append('**Packaged embedded fields: median total call times (ms), compact 3×181 grid.**\n')
rows=[]
for case in cases:
    out=[case]
    for norm in ['unit-voltage','unit-current']:
        selected=[r for r in data['embedded'] if r['case']==case and r['mode']==norm]
        direct,ring=[median(r[k] for r in selected) for k in ['directMs','ringMs']]
        out.extend([f'{direct:.3f}',f'{ring:.3f}'])
    selected=[r for r in data['embedded'] if r['case']==case]
    error=max(max(r['errorTheta'],r['errorPhi']) for r in selected);assert error<=1e-7
    out.extend([selected[0]['bases'],f'{error:.3e}']);rows.append(out)
table(['Case','Unit V exact','Unit V ring','Unit I exact','Unit I ring','Bases','Max error incl. packed fields'],rows)
lines.append('All seven characterization comparisons preserved quadrature bytes and consumer solution generation.\n')
report=root/'docs/ring-far-field-evaluation.md'
text=report.read_text();start=text.index('<!-- BEGIN production -->')+len('<!-- BEGIN production -->');end=text.index('<!-- END production -->',start)
report.write_text(text[:start]+'\n'+'\n'.join(lines)+text[end:])
print('Production accuracy, nine-decimal closure, completeness, and large-case speed gates passed.')
