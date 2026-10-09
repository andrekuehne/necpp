// LU micro-benchmark for the Full NEC audit (prototype, not shipped).
// Times Eigen PartialPivLU on dense complex matrices with NEC-like
// diagonal dominance, in double and float, plus float LU + double iterative
// refinement, and reports the backward error of each variant against the
// double factorization. Also times single-RHS vs blocked multi-RHS triangular
// solves.
//   lu-microbench n=704 [rhs=64] [seed=1]
#include <Eigen/Dense>
#include <chrono>
#include <complex>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <random>
#include <string>

using cd = std::complex<double>;
using cf = std::complex<float>;
using Md = Eigen::Matrix<cd, Eigen::Dynamic, Eigen::Dynamic>;
using Mf = Eigen::Matrix<cf, Eigen::Dynamic, Eigen::Dynamic>;
using Vd = Eigen::Matrix<cd, Eigen::Dynamic, 1>;
using Vf = Eigen::Matrix<cf, Eigen::Dynamic, 1>;

static double now_ms() {
  using namespace std::chrono;
  return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}

int main(int argc, char** argv) {
  std::map<std::string, std::string> a;
  for (int i = 1; i < argc; i++) { std::string s = argv[i]; auto eq = s.find('='); if (eq != std::string::npos) a[s.substr(0, eq)] = s.substr(eq + 1); }
  auto get = [&](const char* k, const char* d) { return a.count(k) ? a[k] : std::string(d); };
  const int n = std::atoi(get("n", "704").c_str());
  const int rhs = std::atoi(get("rhs", "64").c_str());
  const int seed = std::atoi(get("seed", "1").c_str());
  const double diag = std::atof(get("diag", "4").c_str());

  // NEC-like impedance matrix model: entries decay as exp(-j k r)/r with
  // r the segment distance on a 1D arrangement, strong diagonal.
  std::mt19937 rng(seed);
  std::uniform_real_distribution<double> u(-1, 1);
  Md A(n, n);
  const std::string file = get("file", "");
  int n_eff = n;
  if (!file.empty()) {
    FILE* f = std::fopen(file.c_str(), "rb");
    if (!f) { std::fprintf(stderr, "cannot open %s\n", file.c_str()); return 1; }
    int64_t n64 = 0; if (std::fread(&n64, sizeof n64, 1, f) != 1) return 1;
    n_eff = static_cast<int>(n64);
    A.resize(n_eff, n_eff);
    if (std::fread(A.data(), sizeof(cd), static_cast<size_t>(n_eff) * n_eff, f) != static_cast<size_t>(n_eff) * n_eff) return 1;
    std::fclose(f);
  } else
  for (int i = 0; i < n; i++) for (int j = 0; j < n; j++) {
    double r = 0.05 * std::abs(i - j) + 0.02;
    double mag = 1.0 / r;
    double ph = -2 * M_PI * r + 0.1 * u(rng);
    A(i, j) = cd(mag * std::cos(ph), mag * std::sin(ph)) * (1.0 + 0.05 * u(rng));
    if (i == j) A(i, j) += cd(diag * mag, diag * mag);
  }
  const int nn = n_eff;
  Md B = Md::Random(nn, rhs);

  // double LU
  double t0 = now_ms();
  Eigen::PartialPivLU<Md> lud(A);
  double t_lud = now_ms() - t0;
  // double solves, one RHS at a time
  Md Xd(nn, rhs);
  t0 = now_ms();
  for (int c = 0; c < rhs; c++) Xd.col(c) = lud.solve(B.col(c));
  double t_solve1 = now_ms() - t0;
  // double solves, blocked multi-RHS
  t0 = now_ms();
  Md Xd2 = lud.solve(B);
  double t_solveb = now_ms() - t0;

  // float LU
  Mf Af = A.cast<cf>();
  t0 = now_ms();
  Eigen::PartialPivLU<Mf> luf(Af);
  double t_luf = now_ms() - t0;
  // float solve only
  Mf Bf = B.cast<cf>();
  t0 = now_ms();
  Mf Xf = luf.solve(Bf);
  double t_solvef = now_ms() - t0;
  Md Xf_d = Xf.cast<cd>();

  // iterative refinement in double: x += LUf^{-1} (B - A x), residual in double
  Md Xr = Xf_d;
  double t_refine = 0; int iters = 0; double last_res = 0;
  for (int it = 0; it < 3; it++) {
    t0 = now_ms();
    Md R = B - A * Xr;                 // double residual (matrix-free in NEC: Z x)
    Mf Rf = R.cast<cf>();
    Mf D = luf.solve(Rf);
    Xr += D.cast<cd>();
    t_refine += now_ms() - t0;
    iters++;
    last_res = (B - A * Xr).norm() / B.norm();
    if (last_res < 1e-12) break;
  }

  // fp32 fill + fp64 LU: round A to float once, factor and solve in double.
  Md Ar = A.cast<cf>().cast<cd>();
  t0 = now_ms();
  Eigen::PartialPivLU<Md> lur(Ar);
  Md Xfill = lur.solve(B);
  double t_fp32fill = now_ms() - t0;
  const double err_fp32fill = (Xfill - Xd).norm() / Xd.norm();
  std::printf("fp32_fill_fp64_lu: rel_err_vs_double=%.3e (ms=%.1f)\n", err_fp32fill, t_fp32fill);
  const double resd = (B - A * Xd).norm() / B.norm();
  const double resf = (B - A * Xf_d).norm() / B.norm();
  const double errf = (Xf_d - Xd).norm() / Xd.norm();
  const double errr = (Xr - Xd).norm() / Xd.norm();
  // condition estimate via rcond of double LU
  const double rcond = lud.rcond();
  std::printf("n=%d rhs=%d rcond=%.3e file=%s\n", nn, rhs, rcond, file.c_str());
  std::printf("lu_double_ms=%.1f lu_float_ms=%.1f ratio=%.2f\n", t_lud, t_luf, t_lud / t_luf);
  std::printf("solve_double_single_rhs_total_ms=%.2f per_rhs_ms=%.3f solve_double_blocked_ms=%.2f per_rhs_ms=%.3f speedup=%.2f\n",
    t_solve1, t_solve1 / rhs, t_solveb, t_solveb / rhs, t_solve1 / t_solveb);
  std::printf("solve_float_blocked_ms=%.2f\n", t_solvef);
  std::printf("refine_iters=%d refine_total_ms=%.1f (per iter %.1f)\n", iters, t_refine, t_refine / iters);
  std::printf("residual_double=%.3e residual_float=%.3e residual_refined=%.3e\n", resd, resf, last_res);
  std::printf("rel_err_float_vs_double=%.3e rel_err_refined_vs_double=%.3e\n", errf, errr);
  std::printf("mixed_total_ms=%.1f (float LU + refine) vs double_ms=%.1f\n", t_luf + t_refine, t_lud);
  return 0;
}
