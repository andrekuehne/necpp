// Analysis-only harness; not linked into any production target.
#include "nec_stateful_model.h"
#include "electromag.h"
#include "ring.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
double ring_fill_ms=0, ring_factor_ms=0;
using Clock=std::chrono::steady_clock;
double ms(Clock::time_point t){return std::chrono::duration<double,std::milli>(Clock::now()-t).count();}
constexpr double pi_b=3.14159265358979323846;
int main(int argc,char**argv){
 const std::string only=argc>1?argv[1]:"regular4";
 const int rounds=argc>2?std::stoi(argv[2]):3;
 const int side=only=="regular16"||only=="sunflower256"?16:only=="regular8"?8:4;
 const bool ground=only!="free4";
 const double lambda=em::get_wavelength(300e6);
 for(int round=0;round<rounds;++round){
  nec_stateful_model model;
  std::vector<nec_port_definition> ports;
  std::vector<double> xs,ys;
  for(int i=0;i<side*side;++i){
   double x=.5*(i%side-(side-1)/2.), y=.5*(i/side-(side-1)/2.);
   if(only=="sunflower256") {double r=.5*std::sqrt(i/pi_b), phi=i*pi_b*(3-std::sqrt(5.)); x=r*std::cos(phi);y=r*std::sin(phi);}
   // Nonzero horizontal centroid exercises removal and restoration of phase.
   x+=.37;y-=.21;
   double z=.5+(only=="heights4"?.11*std::sin(i*1.7):0);
   double ux=0,uy=0,uz=1;
   if(only=="tilted4"){ux=std::cos(i*1.3)*.8;uy=std::sin(i*1.3)*.8;uz=.6;}
   model.add_wire({i+1,11,(x-.235*ux)*lambda,(y-.235*uy)*lambda,(z-.235*uz)*lambda,(x+.235*ux)*lambda,(y+.235*uy)*lambda,(z+.235*uz)*lambda,.001*lambda});
   ports.push_back({i+1,6}); xs.push_back(x);ys.push_back(y);
  }
  model.complete_geometry(); model.define_ports(ports);
  model.set_ground({ground?nec_ground_kind::perfect:nec_ground_kind::free_space});
  const double d=std::hypot(*std::max_element(xs.begin(),xs.end())-*std::min_element(xs.begin(),xs.end()),*std::max_element(ys.begin(),ys.end())-*std::min_element(ys.begin(),ys.end()))+.47;
  const double step=std::min(pi_b/36,.886/(d*8));
  const int nt=std::ceil(pi_b/2/step)+1,np=std::ceil(2*pi_b/step);
  const nec_far_field_grid grid{1,0,nt,90./(nt-1),0,np,360./np};
  auto t=Clock::now();model.prepare(300);const double prepare=ms(t);
  for(int steer=0;steer<2;++steer){
   std::vector<nec_complex> voltages;
   for(int i=0;i<side*side;++i)voltages.push_back(std::polar(1.,-2*pi_b*(xs[i]*(.12+steer*.03)+ys[i]*.19)));
   t=Clock::now(); const auto solution=model.solve_port_voltages_detailed(voltages);const double solve=ms(t);
   if(model.factorization_generation()!=1)throw std::runtime_error("LU not retained");
   t=Clock::now();const auto& exact=model.compute_far_field(grid);const double direct=ms(t);
   const auto snapshot=model.capture_far_field_snapshot();
   t=Clock::now(); const auto tile=ring_bench::direct(snapshot,grid);const double tileMs=ms(t);
   t=Clock::now(); const auto ring=ring_bench::evaluate(snapshot,grid);const double ringMs=ms(t);
   double peakT=0,peakP=0,peak=0,errT=0,errP=0,interpolation=0,oracle=0,pDirect=0,pRing=0;int worstT=0,worstP=0;
   for(size_t i=0;i<exact.e_theta.size();++i){
    const int it=i%nt;
    const double dt=std::abs(exact.e_theta[i]-ring.field.theta(i)),dp=std::abs(exact.e_phi[i]-ring.field.phi(i));
    if(dt>errT){errT=dt;worstT=it;}if(dp>errP){errP=dp;worstP=it;}
    peakT=std::max(peakT,std::abs(exact.e_theta[i]));peakP=std::max(peakP,std::abs(exact.e_phi[i]));
    peak=std::max(peak,std::sqrt(std::norm(exact.e_theta[i])+std::norm(exact.e_phi[i])));
    interpolation=std::max({interpolation,std::abs(tile.theta(i)-ring.field.theta(i)),std::abs(tile.phi(i)-ring.field.phi(i))});
    oracle=std::max({oracle,std::abs(exact.e_theta[i]-tile.theta(i)),std::abs(exact.e_phi[i]-tile.phi(i))});
    const double weight=std::sin(it*grid.theta_step_deg*pi_b/180)*(it==0||it==nt-1?.5:1.);
    pDirect+=weight*(std::norm(exact.e_theta[i])+std::norm(exact.e_phi[i]));
    pRing+=weight*(std::norm(ring.field.theta(i))+std::norm(ring.field.phi(i)));
   }
   const double scale=grid.theta_step_deg*pi_b/180*2*pi_b/np/(2*std::sqrt(4*pi_b*1e-7/8.854e-12));
   // free4 has identical vertical elements at one height: lower-hemisphere
   // intensity is its upper-hemisphere reflection, so double its integral.
   pDirect*=scale*(ground?1:2);pRing*=scale*(ground?1:2);
   const double closureDelta=(pRing-pDirect)/solution.power_budget.radiated_power_w;
   if(!std::isfinite(errT)||!std::isfinite(errP)||errT>1e-7*peak||errP>1e-7*peak||std::abs(closureDelta)>1e-7)throw std::runtime_error("accuracy gate failed");
   const auto contributions=exact.diagnostics.segment_direction_contributions;
   auto ringGrid=grid;ringGrid.ring=true;
   t=Clock::now();const auto& integrated=model.compute_far_field(ringGrid);const double integratedMs=ms(t);
   for(size_t i=0;i<integrated.sample_count();++i)
    if(std::abs(integrated.e_theta[i]-ring.field.theta(i))>1e-7*peak ||
       std::abs(integrated.e_phi[i]-ring.field.phi(i))>1e-7*peak)throw std::runtime_error("integrated ring gate failed");
   std::cout
     << std::setprecision(17)
     << "{\"case\":\""
     << only
     << "\",\"round\":"
     << round
     << ",\"steer\":"
     << steer
     << ",\"segments\":"
     << side*side*11
     << ",\"nt\":"
     << nt
     << ",\"np\":"
     << np
     << ",\"contributions\":"
     << contributions
     << ",\"prepareMs\":"
     << prepare
     << ",\"fillMs\":"
     << ring_fill_ms
     << ",\"factorMs\":"
     << ring_factor_ms
     << ",\"solveMs\":"
     << solve
     << ",\"directMs\":"
     << direct
     << ",\"tileMs\":"
     << tileMs
     << ",\"ringMs\":"
     << ringMs
     << ",\"integratedRingMs\":"
     << integratedMs
     << ",\"ringDirections\":"
     << ring.directions
     << ",\"fallbackRings\":"
     << ring.fallback
     << ",\"maxL\":"
     << ring.maxL
     << ",\"maxSegmentExtra\":"
     << ring.maxSegmentExtra
     << ",\"errorTheta\":"
     << errT/peak
     << ",\"errorPhi\":"
     << errP/peak
     << ",\"componentErrorTheta\":"
     << (peakT?errT/peakT:0)
     << ",\"componentErrorPhi\":"
     << (peakP?errP/peakP:0)
     << ",\"worstThetaRingDeg\":"
     << worstT*grid.theta_step_deg
     << ",\"worstPhiRingDeg\":"
     << worstP*grid.theta_step_deg
     << ",\"tileOracleError\":"
     << oracle/peak
     << ",\"interpolationError\":"
     << interpolation/peak
     << ",\"closureDirect\":"
     << pDirect/solution.power_budget.radiated_power_w
     << ",\"closureRing\":"
     << pRing/solution.power_budget.radiated_power_w
     << ",\"closureDelta\":"
     << closureDelta
     << ",\"tailBoundRelative\":"
     << ring.bound/peak
     << ",\"sourceCondition\":"
     << ring.sourceNorm/peak
     << "}"
     << std::endl;
  }
 }
}
