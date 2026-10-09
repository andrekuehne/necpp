// Native driver over the stable C ABI (the same code path the WASM package
// uses) for the Full NEC performance audit. Builds the visualizer's element
// geometries, runs the job sequence, and prints per-stage wall times.
//
//   native-driver element=dipole layout=sunflower count=64 ground=perfect \
//     theta=78 phi=308 embedded=19x72 steers=3 [ring=1] [repeat=1]
#include "necpp_wasm_v1.h"
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>

static double now_ms() {
  using namespace std::chrono;
  return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}
static const double C0 = 299792458.0;
static const double F_HZ = 10e9;
static const double LAMBDA = C0 / F_HZ;

struct Wire { int segments; double s[3], e[3], r; };
struct Pattern { std::vector<Wire> wires; std::vector<std::pair<int,int>> ports; int ground_connection; };

static Pattern dipole(int segments) {
  Pattern p; double half = 0.47 * LAMBDA / 2, h = 0.25 * LAMBDA;
  p.wires.push_back({segments, {-half, 0, h}, {half, 0, h}, 0.001 * LAMBDA});
  p.ports.push_back({0, (segments + 1) / 2}); p.ground_connection = 0; return p;
}
static Pattern crossed(int segments) {
  Pattern p; double half = 0.47 * LAMBDA / 2, h = 0.25 * LAMBDA, sep = 0.005 * LAMBDA, r = 0.001 * LAMBDA;
  p.wires.push_back({segments, {-half, 0, h - sep / 2}, {half, 0, h - sep / 2}, r});
  p.wires.push_back({segments, {0, -half, h + sep / 2}, {0, half, h + sep / 2}, r});
  p.ports.push_back({0, (segments + 1) / 2}); p.ports.push_back({1, (segments + 1) / 2}); p.ground_connection = 0; return p;
}
static Pattern helix() {
  Pattern p; double D = 0.27056 * LAMBDA, pitch = 0.18067 * LAMBDA, turns = 5, feed = 0.04 * LAMBDA, wr = 0.001 * LAMBDA;
  int cpt = std::max(1, (int)std::lround(std::hypot(M_PI * D, pitch) / LAMBDA * 12));
  int chords = std::max(3, (int)std::lround(cpt * turns)); double radius = D / 2;
  p.wires.push_back({1, {radius, 0, 0}, {radius, 0, feed}, wr});
  double prev[3] = {radius, 0, feed};
  for (int i = 0; i < chords; i++) {
    double phi = 2 * M_PI * turns * (i + 1) / chords;
    double next[3] = {radius * std::cos(phi), radius * std::sin(phi), feed + pitch * phi / (2 * M_PI)};
    Wire w{1, {prev[0], prev[1], prev[2]}, {next[0], next[1], next[2]}, wr}; p.wires.push_back(w);
    std::memcpy(prev, next, sizeof prev);
  }
  p.ports.push_back({0, 1}); p.ground_connection = 1; return p;
}

static void check(necpp_wasm_v1_model* m, int32_t status, const char* what) {
  if (status != NECPP_WASM_V1_OK) { std::fprintf(stderr, "%s failed: %d %s\n", what, status, necpp_wasm_v1_last_error(m)); std::exit(1); }
}

int main(int argc, char** argv) {
  std::map<std::string, std::string> a;
  for (int i = 1; i < argc; i++) { std::string s = argv[i]; auto eq = s.find('='); if (eq != std::string::npos) a[s.substr(0, eq)] = s.substr(eq + 1); }
  auto get = [&](const char* k, const char* d) { return a.count(k) ? a[k] : std::string(d); };
  std::string element = get("element", "dipole"), layout = get("layout", "sunflower"), ground = get("ground", "perfect");
  int count = std::atoi(get("count", "64").c_str()), segments = std::atoi(get("segments", "11").c_str());
  int theta = std::atoi(get("theta", "19").c_str()), phi = std::atoi(get("phi", "72").c_str());
  int steers = std::atoi(get("steers", "3").c_str()), ring = std::atoi(get("ring", "1").c_str());
  int repeat = std::atoi(get("repeat", "1").c_str());
  std::string embedded = get("embedded", "");
  double spacing = std::atof(get("spacing", "0.5").c_str()) * LAMBDA;

  Pattern pat = element == "dipole" ? dipole(segments) : element == "crossed" ? crossed(segments) : helix();
  if (element == "helix" && spacing < 0.6 * LAMBDA) spacing = 0.6 * LAMBDA;
  std::vector<std::pair<double,double>> pos;
  if (layout == "sunflower") {
    const double golden = M_PI * (3 - std::sqrt(5.0));
    for (int i = 0; i < count; i++) { double r = spacing * std::sqrt((i + 0.5) / M_PI); pos.push_back({r * std::cos(i * golden), r * std::sin(i * golden)}); }
  } else {
    int nx = (int)std::ceil(std::sqrt((double)count)), ny = (int)std::ceil((double)count / nx);
    for (int i = 0; i < count; i++) pos.push_back({((i % nx) - (nx - 1) / 2.0) * spacing, ((i / nx) - (ny - 1) / 2.0) * spacing});
  }

  double t0 = now_ms();
  necpp_wasm_v1_model* m = necpp_wasm_v1_model_create();
  std::vector<int32_t> port_tags, port_segs; int tag = 1;
  for (auto& xy : pos) {
    int base = tag;
    for (auto& w : pat.wires) {
      check(m, necpp_wasm_v1_add_wire(m, tag, w.segments, w.s[0] + xy.first, w.s[1] + xy.second, w.s[2], w.e[0] + xy.first, w.e[1] + xy.second, w.e[2], w.r), "add_wire");
      tag++;
    }
    for (auto& p : pat.ports) { port_tags.push_back(base + p.first); port_segs.push_back(p.second); }
  }
  check(m, necpp_wasm_v1_complete_geometry(m, pat.ground_connection), "complete_geometry");
  check(m, necpp_wasm_v1_define_ports(m, port_tags.data(), port_segs.data(), port_tags.size()), "define_ports");
  check(m, necpp_wasm_v1_set_ground(m, ground == "perfect" ? NECPP_WASM_V1_GROUND_PERFECT : NECPP_WASM_V1_GROUND_FREE_SPACE, 1.0, 0.0), "set_ground");
  double t1 = now_ms();
  std::printf("STAGE geometry ms=%.3f N=%lld P=%zu\n", t1 - t0, (long long)necpp_wasm_v1_geometry_full_segment_count(m), port_tags.size());

  for (int rep = 0; rep < repeat; rep++) {
    t0 = now_ms(); check(m, necpp_wasm_v1_prepare(m, F_HZ / 1e6), "prepare"); t1 = now_ms();
    std::printf("STAGE prepare ms=%.3f\n", t1 - t0);
    t0 = now_ms(); check(m, necpp_wasm_v1_compute_impedance(m), "compute_impedance"); t1 = now_ms();
    std::printf("STAGE impedance ms=%.3f order=%zu cond=%g\n", t1 - t0, necpp_wasm_v1_impedance_order(m), necpp_wasm_v1_impedance_condition_estimate(m));
    size_t P = port_tags.size(); std::vector<double> re(P), im(P);
    double scans[5][2] = {{0, 0}, {0.25, 0}, {0.25, 0.25}, {-0.5, 0.1}, {0.65, 0.35}};
    for (int s = 0; s < steers; s++) {
      double k = 2 * M_PI / LAMBDA; size_t ppe = pat.ports.size();
      for (size_t e = 0; e < pos.size(); e++) { double ph = -k * (pos[e].first * scans[s][0] + pos[e].second * scans[s][1]); for (size_t p = 0; p < ppe; p++) { re[e * ppe + p] = std::cos(ph); im[e * ppe + p] = std::sin(ph); } }
      t0 = now_ms(); check(m, necpp_wasm_v1_solve_currents(m, re.data(), im.data(), P), "solve_currents"); t1 = now_ms();
      std::printf("STAGE solve_currents ms=%.3f steer=%d radiated=%g\n", t1 - t0, s, necpp_wasm_v1_solution_radiated_power_w(m));
    }
    t0 = now_ms(); check(m, necpp_wasm_v1_get_current_distribution(m, NECPP_WASM_V1_CURRENT_LATEST_SOLUTION), "current_distribution"); t1 = now_ms();
    std::printf("STAGE current_distribution ms=%.3f\n", t1 - t0);
    double tstep = theta > 1 ? 90.0 / (theta - 1) : 0, pstep = phi > 1 ? 360.0 / phi : 0;
    t0 = now_ms(); check(m, necpp_wasm_v1_compute_far_field(m, 1.0, 0, theta, tstep, 0, phi, pstep), "far_field"); t1 = now_ms();
    std::printf("STAGE far_field_exact ms=%.3f grid=%dx%d\n", t1 - t0, theta, phi);
    if (ring) {
      t0 = now_ms(); check(m, necpp_wasm_v1_compute_far_field_ring(m, 1.0, 0, theta, tstep, 0, phi, pstep), "far_field_ring"); t1 = now_ms();
      std::printf("STAGE far_field_ring ms=%.3f grid=%dx%d\n", t1 - t0, theta, phi);
    }
    if (!embedded.empty()) {
      int et = 1, ep = 1; std::sscanf(embedded.c_str(), "%dx%d", &et, &ep);
      double ets = et > 1 ? 90.0 / (et - 1) : 0, eps = ep > 1 ? 360.0 / ep : 0;
      t0 = now_ms(); check(m, necpp_wasm_v1_compute_embedded_far_fields(m, 1.0, 0, et, ets, 0, ep, eps, NECPP_WASM_V1_UNIT_CURRENT), "embedded_uc"); t1 = now_ms();
      std::printf("STAGE embedded_unit_current ms=%.3f grid=%dx%d\n", t1 - t0, et, ep);
      t0 = now_ms(); check(m, necpp_wasm_v1_compute_embedded_far_fields(m, 1.0, 0, et, ets, 0, ep, eps, NECPP_WASM_V1_UNIT_VOLTAGE), "embedded_uv"); t1 = now_ms();
      std::printf("STAGE embedded_unit_voltage ms=%.3f grid=%dx%d\n", t1 - t0, et, ep);
    }
  }
  necpp_wasm_v1_model_delete(m);
  return 0;
}
