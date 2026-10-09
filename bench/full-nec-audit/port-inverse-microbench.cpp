// Port-matrix inversion micro-benchmark (prototype): the shipped
// nec_invert_port_matrix() uses JacobiSVD with full U/V to invert Y and
// estimate its condition number. Compare with PartialPivLU inverse + rcond
// and with a Hermitian-split power-iteration condition estimate.
//   port-inverse-microbench p=256
#include <Eigen/Dense>
#include <chrono>
#include <complex>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <string>
using cd = std::complex<double>;
using M = Eigen::Matrix<cd, Eigen::Dynamic, Eigen::Dynamic>;
static double now_ms() { using namespace std::chrono; return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count(); }
int main(int argc, char** argv) {
  std::map<std::string, std::string> a;
  for (int i = 1; i < argc; i++) { std::string s = argv[i]; auto eq = s.find('='); if (eq != std::string::npos) a[s.substr(0, eq)] = s.substr(eq + 1); }
  const int p = std::atoi(a.count("p") ? a["p"].c_str() : "256");
  M Y = M::Random(p, p); Y = Y + Y.transpose().eval(); Y += M::Identity(p, p) * cd(4.0, 2.0); // symmetric, moderately conditioned
  double t0 = now_ms();
  Eigen::JacobiSVD<M> svd(Y, Eigen::ComputeFullU | Eigen::ComputeFullV);
  const double cond_svd = svd.singularValues()(0) / svd.singularValues()(p - 1);
  M Zs = svd.solve(M::Identity(p, p));
  const double t_svd = now_ms() - t0;
  t0 = now_ms();
  Eigen::PartialPivLU<M> lu(Y);
  const double rcond = lu.rcond();
  M Zl = lu.inverse();
  const double t_lu = now_ms() - t0;
  t0 = now_ms();
  Eigen::BDCSVD<M> bdc(Y, Eigen::ComputeThinU | Eigen::ComputeThinV);
  const double cond_bdc = bdc.singularValues()(0) / bdc.singularValues()(p - 1);
  M Zb = bdc.solve(M::Identity(p, p));
  const double t_bdc = now_ms() - t0;
  std::printf("p=%d jacobi_svd_ms=%.1f cond=%.3e | lu_inverse_ms=%.1f 1/rcond=%.3e | bdc_svd_ms=%.1f cond=%.3e | max|Zlu-Zsvd|/max|Z|=%.2e max|Zbdc-Zsvd|/max|Z|=%.2e\n",
    p, t_svd, cond_svd, t_lu, 1.0 / rcond, t_bdc, cond_bdc,
    (Zl - Zs).cwiseAbs().maxCoeff() / Zs.cwiseAbs().maxCoeff(), (Zb - Zs).cwiseAbs().maxCoeff() / Zs.cwiseAbs().maxCoeff());
  return 0;
}
