import assert from "node:assert/strict";
import test from "node:test";
import { createModelFromModule } from "../.test-build/src/model.js";
import { instantiateNecModule } from "../.test-build/src/loader.js";
import { MessageChannel } from "node:worker_threads";
import { createNecModel, createNecArraySolver } from "../.test-build/src/index.js";
import { createNecWorkerModel } from "../.test-build/src/worker.js";
import { FarFieldWorkerPool, StaleFarFieldJobError } from "../.test-build/src/field-worker-pool.js";
import { viewEmbeddedField } from "./fixtures/current-quadrature-packed.mjs";

const grid = { radiusM: 1, theta: { startDeg: 0, count: 19, stepDeg: 5 },
  phi: { startDeg: 13, count: 181, stepDeg: 360 / 181 } };
const planes = ["eThetaReal", "eThetaImag", "ePhiReal", "ePhiImag"];
const weights = { real: Float64Array.of(1, -.4), imag: Float64Array.of(.2, .7) };
async function setup(factory = createNecModel, ground = "perfect", options = {}) {
  const model = await factory(options);
  for (let i = 0; i < 2; ++i) await model.addWire({ tag: i+1, segments: 11,
    start: [.37+i*.6-.188, -.21, .4+i*.2-.141],
    end: [.37+i*.6+.188, -.21, .4+i*.2+.141], radiusM: .001 });
  await model.completeGeometry();
  await model.definePorts([{tag:1,segment:6},{tag:2,segment:6}]);
  await model.setGround({kind:ground});
  await model.prepare({frequencyMHz:300});
  await model.solveVoltages(weights);
  return model;
}
function compare(a,b,tolerance=1e-7) {
  let peak=0, error=0;
  for(let i=0;i<a.eThetaReal.length;++i) {
    peak=Math.max(peak,Math.hypot(...planes.map(p=>a[p][i])));
    for(const component of ["Theta","Phi"])
      error=Math.max(error,Math.hypot(a[`e${component}Real`][i]-b[`e${component}Real`][i],a[`e${component}Imag`][i]-b[`e${component}Imag`][i]));
  }
  assert.ok(error<=tolerance*peak,`relative component error ${error/peak}`);
}
function identical(a,b) { for(const p of planes) assert.deepEqual(a[p],b[p]); }

for(const ground of ["free-space","perfect"]) test(`ring selection and normalized embedded fields: ${ground}`,async()=>{
  const model=await setup(createNecModel,ground,{farFieldEvaluator:"ring"});
  try {
    const exact=await model.computeFarField({...grid,evaluator:"exact"});
    assert.equal(exact.fieldEvaluation,undefined);
    const ring=await model.computeFarField(grid);
    assert.equal(ring.fieldEvaluation.execution,"ring");
    assert.ok(ring.fieldEvaluation.evaluatedDirections<grid.theta.count*grid.phi.count);
    assert.deepEqual(ring.thetaDeg,exact.thetaDeg);assert.deepEqual(ring.phiDeg,exact.phiDeg);
    compare(exact,ring);identical(ring,await model.computeFarField(grid));
    for(const normalization of [{kind:"unit-voltage",valueV:1},{kind:"unit-current",valueA:1}]) {
      const a=await model.computeEmbeddedFarFields({...grid,evaluator:"exact"},normalization);
      const b=await model.computeEmbeddedFarFields(grid,normalization);
      compare(a,b);assert.deepEqual(a.ports,b.ports);assert.equal(b.fieldEvaluation.interpolatedRings,38);
      identical(exact,await model.computeFarField({...grid,evaluator:"exact"}));
      const solution=normalization.kind==="unit-voltage" ? await model.solveVoltages(weights) : await model.solveCurrents(weights);
      const direct=await model.computeFarField({...grid,evaluator:"exact"});
      const combined=Object.fromEntries(planes.map(p=>[p,new Float64Array(b.samplesPerPort)]));
      for(let port=0;port<2;++port) for(let j=0;j<b.samplesPerPort;++j) for(const c of ["Theta","Phi"]) {
        const k=port*b.samplesPerPort+j,r=b[`e${c}Real`][k],im=b[`e${c}Imag`][k];
        combined[`e${c}Real`][j]+=r*weights.real[port]-im*weights.imag[port];
        combined[`e${c}Imag`][j]+=im*weights.real[port]+r*weights.imag[port];
      }
      compare(direct,combined);
      assert.ok(solution.factorizationGeneration>0);
      await model.solveVoltages(weights);
    }
    for(const request of [
      {...grid,phi:{startDeg:17,count:39,stepDeg:2}},
      {...grid,phi:{startDeg:0,count:3,stepDeg:120}},
      {...grid,theta:{startDeg:43,count:1,stepDeg:0}},
      {...grid,theta:{startDeg:0,count:19,stepDeg:10}},
    ]) {
      const a=await model.computeFarField({...request,evaluator:"exact"});
      const b=await model.computeFarField(request);compare(a,b);
      if(request.phi.count<40) { assert.equal(b.fieldEvaluation.execution,"exact");identical(a,b); }
    }
    await model.solveVoltages({real:Float64Array.of(0,0),imag:Float64Array.of(0,0)});
    const zero=await model.computeFarField(grid);assert.ok(planes.every(p=>zero[p].every(x=>x===0)));
  } finally { await model.dispose(); }
});

test("worker model propagates selection, packed provenance and restores the consumer solution",async()=>{
  const model=await setup(createNecWorkerModel,"free-space",{farFieldEvaluator:"ring"});
  const request={field:grid,quadrature:{nodes:Float64Array.of(-1,0,1),images:"physical-only",modes:"unit-current"}};
  try {
    const before=await model.computeFarField(grid);
    assert.equal(before.fieldEvaluation.execution,"ring");
    const characterization=await model.characterizeIsolatedElement(request);
    assert.equal(characterization.embeddedField.schemaVersion,1);
    assert.equal(characterization.fieldEvaluation.execution,"ring");
    const packed=viewEmbeddedField(characterization.embeddedField.buffer);
    const reference=await model.characterizeIsolatedElement({...request,field:{...grid,evaluator:"exact"}});
    const packedExact=viewEmbeddedField(reference.embeddedField.buffer);
    // The packed fields retain the existing binary layout.
    assert.equal(packed.samplesPerPort,packedExact.samplesPerPort);
    compare(packedExact,packed);
    assert.deepEqual(characterization.quadrature.buffer,reference.quadrature.buffer);
    identical(before,await model.computeFarField(grid));
    const {port1,port2}=new MessageChannel();
    const received=new Promise(resolve=>port2.once("message",resolve));
    try {
      const handoff=await model.characterizeIsolatedElement(request,{destination:port1});
      const message=await received;
      assert.equal(handoff.fieldEvaluation.execution,"ring");assert.deepEqual(message.fieldEvaluation,handoff.fieldEvaluation);
    } finally {port1.close();port2.close();}
  } finally {await model.dispose();}
});

test("ring pool is deterministic across workers, recovers and fences cancelled plans",async()=>{
  const model=await setup();const one=new FarFieldWorkerPool(1),two=new FarFieldWorkerPool(2);
  try {
    const snapshot=model.captureFarFieldEvaluationSnapshot();
    await one.setSnapshot(snapshot);await two.setSnapshot(snapshot);
    const request={...grid,evaluator:"ring"};
    const a=await one.computeFarField(request),b=await two.computeFarField(request);
    identical(a,b);assert.deepEqual(a.fieldEvaluation,b.fieldEvaluation);compare(model.computeFarField(grid),b);
    two.terminateEvaluatorForTest(0);
    identical(a,await two.computeFarField(request));
    const stale=two.computeFarField(request);two.cancelActive();
    await assert.rejects(stale,StaleFarFieldJobError);
    const resumed=await two.computeFarField(request);
    identical(a,resumed);assert.ok(resumed.poolDiagnostics.cancelledJobs>=1);
    model.solveVoltages({real:Float64Array.of(.3,-.2),imag:Float64Array.of(-.6,.4)});
    await two.setSnapshot(model.captureFarFieldEvaluationSnapshot());
    const updated=await two.computeFarField(request);compare(model.computeFarField(grid),updated);
    assert.equal(updated.poolDiagnostics.geometryReused,true);
  } finally {one.dispose();two.dispose();model.dispose();}
});

test("array facade opts in once and honors exact override",async()=>{
  const description={elements:[{id:"a",positionM:[.37,-.21],patternId:"dipole"}],patterns:[{
    id:"dipole",kind:"straight-wire-pattern",wires:[{id:"w",segments:11,startM:[-.235,0,.5],endM:[.235,0,.5],radiusM:.001}],ports:[{wireId:"w",segment:6}]}],ground:{kind:"perfect"}};
  for(const fieldWorkers of [1,2,"auto"]) {
    const solver=await createNecArraySolver(description,{symmetry:"off",fieldWorkers,farFieldEvaluator:"ring"});
    try {
      await solver.prepare({frequencyMHz:300});await solver.solveVoltages({real:Float64Array.of(1),imag:Float64Array.of(0)});
      const a=await solver.computeFarField(grid),b=await solver.computeFarField({...grid,evaluator:"exact"});
      assert.equal(a.fieldEvaluation.execution,"ring");assert.equal(b.fieldEvaluation,undefined);compare(b,a);
      assert.equal((await solver.computeEmbeddedFarFields(grid)).fieldEvaluation.execution,"ring");
    } finally {await solver.dispose();}
  }
});

test("unsupported ground falls back, and invalid selectors fail",async()=>{
  await assert.rejects(createNecModel({farFieldEvaluator:"invalid"}),/evaluator/);
  await assert.rejects(createNecWorkerModel({farFieldEvaluator:"invalid"}),/evaluator/);
  const model=await setup();
  try {
    assert.throws(()=>model.computeFarField({...grid,evaluator:"invalid"}),/evaluator/);
    model.setGround({kind:"finite",method:"reflection-coefficient",relativePermittivity:13,conductivitySPerM:.005});
    model.prepare({frequencyMHz:300});model.solveVoltages(weights);
    const a=model.computeFarField(grid),b=model.computeFarField({...grid,evaluator:"ring"});
    assert.equal(b.fieldEvaluation.execution,"exact");assert.equal(b.fieldEvaluation.fallbackReason,"unsupported-model");identical(a,b);
  } finally {model.dispose();}
});

test("symmetry origin is restored exactly once for ring fields and embedded bases",async()=>{
  const description={elements:[[-.5,-.5],[.5,-.5],[-.5,.5],[.5,.5]].map(([x,y],i)=>({id:String(i),positionM:[x+.37,y-.21],patternId:"d"})),
    patterns:[{id:"d",kind:"straight-wire-pattern",wires:[{id:"w",segments:11,startM:[0,0,.265],endM:[0,0,.735],radiusM:.001}],ports:[{wireId:"w",segment:6}]}],ground:{kind:"perfect"}};
  const solvers=[];
  try {
    for(const symmetry of ["off","require"]) {
      const solver=await createNecArraySolver(description,{symmetry,symmetrizer:{positionEpsilonM:1e-12,allowRotation:false},fieldWorkers:1,farFieldEvaluator:"ring"});
      solvers.push(solver);await solver.prepare({frequencyMHz:300});
      await solver.solveVoltages({real:Float64Array.of(1,.3,-.2,.7),imag:Float64Array.of(.2,-.4,.3,.1)});
    }
    compare(await solvers[0].computeFarField({...grid,evaluator:"exact"}),await solvers[1].computeFarField(grid));
    compare(await solvers[0].computeEmbeddedFarFields({...grid,evaluator:"exact"}),await solvers[1].computeEmbeddedFarFields(grid));
  } finally {for(const solver of solvers)await solver.dispose();}
});

test("a missing optional ring ABI falls back to exact with provenance",async()=>{
  const module=await instantiateNecModule();
  delete module._necpp_wasm_v1_compute_far_field_ring;
  const model=await setup(async options=>createModelFromModule(module,options.farFieldEvaluator),"perfect",{farFieldEvaluator:"ring"});
  try {
    const a=model.computeFarField({...grid,evaluator:"exact"}),b=model.computeFarField(grid);
    identical(a,b);assert.equal(b.fieldEvaluation.fallbackReason,"ring-capability-unavailable");
  } finally {model.dispose();}
});

test("ring embedded evaluation preserves a prepared model without a consumer solution",async()=>{
  const model=await setup(createNecModel,"perfect",{farFieldEvaluator:"ring"});
  try {
    model.prepare({frequencyMHz:301});
    assert.equal(model.state,"prepared");
    for(const normalization of [{kind:"unit-voltage",valueV:1},{kind:"unit-current",valueA:1}]) {
      const reference=model.computeEmbeddedFarFields({...grid,evaluator:"exact"},normalization);
      const ring=model.computeEmbeddedFarFields(grid,normalization);
      compare(reference,ring);assert.equal(ring.fieldEvaluation.execution,"ring");
      assert.equal(model.state,"prepared");
      assert.throws(()=>model.computeFarField(grid));
    }
    model.solveVoltages(weights);
    compare(model.computeFarField({...grid,evaluator:"exact"}),model.computeFarField(grid));
  } finally {model.dispose();}
});
