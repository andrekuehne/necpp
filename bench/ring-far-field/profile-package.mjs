// Profile the shipped WASM package, with no worker pool or symmetry reduction.
import { createNecModel } from '../../packages/necpp-wasm/dist/index.js';
import { performance } from 'node:perf_hooks';
const lambda = 1 / Math.sqrt(4*Math.PI*1e-7*8.854e-12) / 300e6;
for (const [name, side] of [['regular4',4],['regular8',8],['regular16',16],['sunflower256',16]]) {
  for (let round=0; round<3; ++round) {
    const model = await createNecModel();
    const xy=Array.from({length:side*side},(_,i)=>name.startsWith('sunflower')
      ? [0.5*Math.sqrt(i/Math.PI)*Math.cos(i*Math.PI*(3-Math.sqrt(5))),0.5*Math.sqrt(i/Math.PI)*Math.sin(i*Math.PI*(3-Math.sqrt(5)))]
      : [0.5*(i%side-(side-1)/2),0.5*(Math.floor(i/side)-(side-1)/2)]);
    xy.forEach(([x,y],i)=>model.addWire({tag:i+1,segments:11,start:[x*lambda,y*lambda,0.265*lambda],end:[x*lambda,y*lambda,0.735*lambda],radiusM:0.001*lambda}));
    model.completeGeometry({groundConnection:'none'});
    model.definePorts(xy.map((_,i)=>({tag:i+1,segment:6})));
    model.setGround({kind:'perfect'});
    const d=Math.hypot(Math.max(...xy.map(p=>p[0]))-Math.min(...xy.map(p=>p[0])),Math.max(...xy.map(p=>p[1]))-Math.min(...xy.map(p=>p[1])))+0.47;
    const step=Math.min(Math.PI/36,0.886/(d*8));
    const nt=Math.ceil(Math.PI/2/step)+1,np=Math.max(3,Math.ceil(2*Math.PI/step));
    const grid={radiusM:1,theta:{startDeg:0,count:nt,stepDeg:90/(nt-1)},phi:{startDeg:0,count:np,stepDeg:360/np}};
    let t=performance.now(); model.prepare({frequencyMHz:300}); const prepareMs=performance.now()-t;
    const samples=[];
    for(let steer=0;steer<4;++steer){
      const phases=xy.map(([x,y])=>-2*Math.PI*(x*(0.12+steer*0.03)+y*0.19));
      t=performance.now();const solution=model.solveVoltages({real:Float64Array.from(phases,Math.cos),imag:Float64Array.from(phases,Math.sin)}); const solveMs=performance.now()-t;
      t=performance.now();const field=model.computeFarField(grid);const fieldMs=performance.now()-t;
      if(solution.factorizationGeneration!==1)throw Error('factorization not retained');
      samples.push({steer,solveMs,fieldMs,counts:field.diagnostics?.counts});
    }
    console.log(JSON.stringify({name,round,segments:xy.length*11,nt,np,directions:nt*np,prepareMs,samples}));
    model.dispose();
  }
}
