#include <catch2/catch_test_macros.hpp>
#include "nec_stateful_model.h"
#include <algorithm>

namespace {
void compare_ring(const nec_far_field_result& exact,const nec_far_field_result& ring) {
  double peak=0,error=0;
  REQUIRE(exact.theta_deg==ring.theta_deg);
  REQUIRE(exact.phi_deg==ring.phi_deg);
  for(size_t i=0;i<exact.sample_count();++i) {
    peak=std::max(peak,std::hypot(std::abs(exact.e_theta[i]),std::abs(exact.e_phi[i])));
    error=std::max({error,std::abs(exact.e_theta[i]-ring.e_theta[i]),std::abs(exact.e_phi[i]-ring.e_phi[i])});
  }
  REQUIRE(error<=1e-7*peak);
}
}
TEST_CASE("Ring fields preserve the exact path and cache invalidation", "[ring]") {
  for(auto ground:{nec_ground_kind::free_space,nec_ground_kind::perfect}) {
    nec_stateful_model model;
    model.add_wire({1,11,.1,-.2,.3,.4,-.2,.662,.001});
    model.add_wire({2,11,.8,.1,.4,.8,.4,.762,.001});
    model.complete_geometry();model.define_ports({{1,6},{2,6}});model.set_ground({ground});
    for(double frequency:{300.,310.}) {
      model.prepare(frequency);
      for(auto drive:{nec_complex(1.,.3),nec_complex(1e-100,-1e-100)}) {
        model.solve_port_voltages({drive,-drive});
        nec_far_field_grid grid{1,13,17,4.25,17,181,360./181};
        const auto exact=model.compute_far_field(grid);
        grid.ring=true;const auto ring=model.compute_far_field(grid);
        REQUIRE(ring.evaluation.rings>0);compare_ring(exact,ring);
        REQUIRE(ring.e_theta==model.compute_far_field(grid).e_theta);
        for(auto normalization:{nec_embedded_field_normalization::unit_voltage,nec_embedded_field_normalization::unit_current}) {
          const auto embedded=model.compute_embedded_far_fields(grid,normalization);
          REQUIRE(embedded.evaluation.rings==2*grid.theta_count);
          REQUIRE(ring.e_theta==model.compute_far_field(grid).e_theta);
        }
        grid.ring=false;REQUIRE(exact.e_theta==model.compute_far_field(grid).e_theta);
        grid.phi_count=3;grid.phi_step_deg=120;
        const auto small=model.compute_far_field(grid);
        grid.ring=true;const auto fallback=model.compute_far_field(grid);
        REQUIRE(fallback.evaluation.rings==0);REQUIRE(small.e_theta==fallback.e_theta);
      }
    }
  }
}
TEST_CASE("Ring cutoffs are bounded for extreme inputs", "[ring]") {
  REQUIRE(nec_ring::cutoff(INFINITY,1e-14,50)==50);
  REQUIRE(nec_ring::cutoff(100,0,50)==50);
  for(double a:{0.,.01,1.,10.,100.,1000.}) {
    const int n=nec_ring::cutoff(a,1e-14,10000);
    REQUIRE(nec_ring::log_tail(a,n)<=std::log(1e-14));
  }
}
