// Run after npm run build --prefix packages/necpp-wasm. Timings never overlap.
import assert from "node:assert/strict";
import { createNecModel } from "../../packages/necpp-wasm/dist/index.js";
import { FarFieldWorkerPool } from "../../packages/necpp-wasm/dist/field-worker-pool.js";
import { viewEmbeddedField } from "../../packages/necpp-wasm/test/fixtures/current-quadrature-packed.mjs";
const mode=process.argv[2]??"workers";
const rounds=Number(process.argv[3]??3);
// Match em::speed_of_light(), including the legacy pi constant.
const lambda=1/Math.sqrt(4*3.1415926536*1e-7*8.854e-12)/300e6;
const cases=["regular4","regular8","regular16","sunflower256","free4","heights4","tilted4"];
function compare(a,b) {
  let peak=0,dt=0,dp=0;
  for(let i=0;i<a.eThetaReal.length;++i) {
    peak=Math.max(peak,Math.hypot(a.eThetaReal[i],a.eThetaImag[i],a.ePhiReal[i],a.ePhiImag[i]));
    dt=Math.max(dt,Math.hypot(a.eThetaReal[i]-b.eThetaReal[i],a.eThetaImag[i]-b.eThetaImag[i]));
    dp=Math.max(dp,Math.hypot(a.ePhiReal[i]-b.ePhiReal[i],a.ePhiImag[i]-b.ePhiImag[i]));
  }
  assert.ok(dt<=1e-7*peak&&dp<=1e-7*peak);
  return {errorTheta:dt/peak,errorPhi:dp/peak};
}
for(const name of cases) {
  console.error(mode,name);
  const model=await createNecModel();let pool;
  try {
    const side=name==="regular16"||name==="sunflower256"?16:name==="regular8"?8:4;
    const ports=[],xs=[],ys=[];
    for(let i=0;i<side*side;++i) {
      let x=.5*(i%side-(side-1)/2),y=.5*(Math.floor(i/side)-(side-1)/2);
      if(name==="sunflower256") {
        const r=.5*Math.sqrt(i/Math.PI),phi=i*Math.PI*(3-Math.sqrt(5));x=r*Math.cos(phi);y=r*Math.sin(phi);
      }
      x+=.37;y-=.21;xs.push(x);ys.push(y);
      const z=.5+(name==="heights4"?.11*Math.sin(i*1.7):0);
      const direction=name==="tilted4"?[.8*Math.cos(i*1.3),.8*Math.sin(i*1.3),.6]:[0,0,1];
      model.addWire({tag:i+1,segments:11,start:[x,y,z].map((v,j)=>(v-.235*direction[j])*lambda),
        end:[x,y,z].map((v,j)=>(v+.235*direction[j])*lambda),radiusM:.001*lambda});
      ports.push({tag:i+1,segment:6});
    }
    model.completeGeometry();model.definePorts(ports);model.setGround({kind:name==="free4"?"free-space":"perfect"});
    model.prepare({frequencyMHz:300});
    const solution=model.solveVoltages({real:Float64Array.from(xs,(x,i)=>Math.cos(-2*Math.PI*(x*.15+ys[i]*.19))),
      imag:Float64Array.from(xs,(x,i)=>Math.sin(-2*Math.PI*(x*.15+ys[i]*.19)))});
    const d=Math.hypot(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys))+.47;
    const step=Math.min(Math.PI/36,.886/(d*8)),nt=Math.ceil(Math.PI/2/step)+1,np=Math.ceil(2*Math.PI/step);
    const grid=mode==="workers"?{radiusM:1,theta:{startDeg:0,count:nt,stepDeg:90/(nt-1)},phi:{startDeg:0,count:np,stepDeg:360/np}}
      :{radiusM:1,theta:{startDeg:0,count:3,stepDeg:45},phi:{startDeg:13,count:181,stepDeg:360/181}};
    if(mode==="workers") {
      pool=new FarFieldWorkerPool(2);await pool.setSnapshot(model.captureFarFieldEvaluationSnapshot());
      for(let round=0;round<rounds;++round) {
        let start=performance.now();const exact=await pool.computeFarField(grid);const directMs=performance.now()-start;
        start=performance.now();const ring=await pool.computeFarField({...grid,evaluator:"ring"});const ringMs=performance.now()-start;
        console.log(JSON.stringify({case:name,round,mode,segments:side*side*11,directions:nt*np,directMs,ringMs,
          ...compare(exact,ring),...ring.fieldEvaluation,workers:ring.poolDiagnostics.workers,warmupMs:pool.warmupMs}));
      }
    } else {
      for(const normalization of [{kind:"unit-voltage",valueV:1},{kind:"unit-current",valueA:1}]) {
        for(let round=0;round<rounds;++round) {
          let start=performance.now();const exact=model.computeEmbeddedFarFields(grid,normalization);const directMs=performance.now()-start;
          start=performance.now();const ring=model.computeEmbeddedFarFields({...grid,evaluator:"ring"},normalization);const ringMs=performance.now()-start;
          console.log(JSON.stringify({case:name,round,mode:normalization.kind,segments:side*side*11,directions:543,bases:ports.length,
            directMs,ringMs,...compare(exact,ring),...ring.fieldEvaluation}));
        }
      }
      const request={field:grid,quadrature:{nodes:Float64Array.of(-1,0,1),images:"physical-only",modes:"unit-current"}};
      const exact=model.characterizeIsolatedElement(request);
      const ring=model.characterizeIsolatedElement({...request,field:{...grid,evaluator:"ring"}});
      assert.deepEqual(exact.quadrature.buffer,ring.quadrature.buffer);
      console.log(JSON.stringify({case:name,mode:"characterization",segments:side*side*11,directions:543,bases:ports.length,
        ...compare(viewEmbeddedField(exact.embeddedField.buffer),viewEmbeddedField(ring.embeddedField.buffer)),...ring.fieldEvaluation}));
    }
    assert.equal(model.captureFarFieldEvaluationSnapshot().solutionGeneration,solution.solveGeneration);
  } finally {pool?.dispose();model.dispose();}
}
