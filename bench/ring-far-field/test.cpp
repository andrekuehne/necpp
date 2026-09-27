#include "ring.hpp"
#include <iostream>
#include <stdexcept>
void require(bool value){if(!value)throw std::runtime_error("ring test failed");}
int main(){
 for(bool ground:{false,true}){
  nec_far_field_snapshot s;s.wavelength_m=1;s.perfect_ground=ground;
  for(int i=0;i<13;++i){
   s.x.push_back(.37+2*std::cos(i*2.4));s.y.push_back(-.21+2*std::sin(i*2.4));s.z.push_back(.3+.2*i);
   s.cab.push_back(.8*std::cos(i));s.sab.push_back(.8*std::sin(i));s.salp.push_back(.6);
   s.segment_half_lengths.push_back(.067);
   s.air.push_back(std::cos(i*.7));s.aii.push_back(std::sin(i*1.3));s.bir.push_back(.2);s.bii.push_back(-.3);s.cir.push_back(.4);s.cii.push_back(.5);
  }
  for(const nec_far_field_grid g:{nec_far_field_grid{1,0,19,10,13,181,360./181},nec_far_field_grid{1,0,10,10,0,3,120},nec_far_field_grid{1,5,7,12,17,39,2}}){
   const auto a=ring_bench::direct(s,g);const auto b=ring_bench::evaluate(s,g);const auto repeat=ring_bench::evaluate(s,g);
   double peak=0,error=0;
   for(size_t i=0;i<a.tr.size();++i){peak=std::max({peak,std::abs(a.theta(i)),std::abs(a.phi(i))});error=std::max({error,std::abs(a.theta(i)-b.field.theta(i)),std::abs(a.phi(i)-b.field.phi(i))});}
   require(error<=1e-7*peak);require(b.field.tr==repeat.field.tr&&b.field.ti==repeat.field.ti&&b.field.pr==repeat.field.pr&&b.field.pi==repeat.field.pi);
   if(g.phi_count==39||g.phi_count==3){require(b.fallback==g.theta_count);require(a.tr==b.field.tr&&a.ti==b.field.ti&&a.pr==b.field.pr&&a.pi==b.field.pi);}
  }
  for(auto*v:{&s.air,&s.aii,&s.bir,&s.bii,&s.cir,&s.cii})std::fill(v->begin(),v->end(),0);
  const auto zero=ring_bench::evaluate(s,{1,0,3,45,0,100,3.6});
  require(zero.fallback==3);for(double x:zero.field.tr)require(x==0);
 }
 for(double a:{0.,.01,1.,10.,100.,1000.}){int n=ring_bench::cutoff(a,1e-14);require(ring_bench::log_tail(a,n)<=std::log(1e-14));if(n>int(a))require(ring_bench::log_tail(a,n-1)>std::log(1e-14));}
 std::cout<<"ring tests passed: free/PEC, tilted varying heights, translated centroid, full sphere, nonzero phi start, prime grid, direct fallbacks, zero currents, repeatability, tail selector\n";
}
