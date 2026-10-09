// Complex GEMM micro-kernel prototype for the Full NEC audit (not shipped).
// The LU trailing update C -= A*B dominates factorization time. Compare:
//   (1) Eigen's complex<double> GEMM (what PartialPivLU uses today),
//   (2) a scalar split real/imag layout kernel,
//   (3) the same split-layout kernel with wasm f64x2 SIMD (2 columns/lane),
//       using a 4x4 register block (4 rows x 2 vectors of 2 columns).
//   gemm-microbench m=512 n=512 k=256
#include <Eigen/Dense>
#include <chrono>
#include <complex>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <string>
#include <vector>
#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif
using cd = std::complex<double>;
using M = Eigen::Matrix<cd, Eigen::Dynamic, Eigen::Dynamic, Eigen::RowMajor>;
static double now_ms() { using namespace std::chrono; return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count(); }

// Split layout, row-major: A (m x k), B (k x n), C (m x n). C -= A*B.
static void gemm_split_scalar(int m, int n, int k, const double* Ar, const double* Ai, const double* Br, const double* Bi, double* Cr, double* Ci) {
  for (int i = 0; i < m; i++) {
    for (int p = 0; p < k; p++) {
      const double ar = Ar[i * k + p], ai = Ai[i * k + p];
      const double* br = Br + p * n; const double* bi = Bi + p * n;
      double* cr = Cr + i * n; double* ci = Ci + i * n;
      for (int j = 0; j < n; j++) {
        cr[j] -= ar * br[j] - ai * bi[j];
        ci[j] -= ar * bi[j] + ai * br[j];
      }
    }
  }
}

#ifdef __wasm_simd128__
// 4 rows x 4 columns register block, k inner. Requires n % 4 == 0, m % 4 == 0.
static void gemm_split_simd(int m, int n, int k, const double* Ar, const double* Ai, const double* Br, const double* Bi, double* Cr, double* Ci) {
  for (int i = 0; i < m; i += 4) {
    for (int j = 0; j < n; j += 4) {
      v128_t cr[4][2], ci[4][2];
      for (int r = 0; r < 4; r++) for (int c = 0; c < 2; c++) { cr[r][c] = wasm_v128_load(Cr + (i + r) * n + j + 2 * c); ci[r][c] = wasm_v128_load(Ci + (i + r) * n + j + 2 * c); }
      for (int p = 0; p < k; p++) {
        const v128_t br0 = wasm_v128_load(Br + p * n + j), br1 = wasm_v128_load(Br + p * n + j + 2);
        const v128_t bi0 = wasm_v128_load(Bi + p * n + j), bi1 = wasm_v128_load(Bi + p * n + j + 2);
        for (int r = 0; r < 4; r++) {
          const v128_t ar = wasm_f64x2_splat(Ar[(i + r) * k + p]);
          const v128_t ai = wasm_f64x2_splat(Ai[(i + r) * k + p]);
          // cr -= ar*br - ai*bi ; ci -= ar*bi + ai*br
          cr[r][0] = wasm_f64x2_sub(cr[r][0], wasm_f64x2_sub(wasm_f64x2_mul(ar, br0), wasm_f64x2_mul(ai, bi0)));
          cr[r][1] = wasm_f64x2_sub(cr[r][1], wasm_f64x2_sub(wasm_f64x2_mul(ar, br1), wasm_f64x2_mul(ai, bi1)));
          ci[r][0] = wasm_f64x2_sub(ci[r][0], wasm_f64x2_add(wasm_f64x2_mul(ar, bi0), wasm_f64x2_mul(ai, br0)));
          ci[r][1] = wasm_f64x2_sub(ci[r][1], wasm_f64x2_add(wasm_f64x2_mul(ar, bi1), wasm_f64x2_mul(ai, br1)));
        }
      }
      for (int r = 0; r < 4; r++) for (int c = 0; c < 2; c++) { wasm_v128_store(Cr + (i + r) * n + j + 2 * c, cr[r][c]); wasm_v128_store(Ci + (i + r) * n + j + 2 * c, ci[r][c]); }
    }
  }
}
#endif

int main(int argc, char** argv) {
  std::map<std::string, std::string> a;
  for (int i = 1; i < argc; i++) { std::string s = argv[i]; auto eq = s.find('='); if (eq != std::string::npos) a[s.substr(0, eq)] = s.substr(eq + 1); }
  auto geti = [&](const char* key, int d) { return a.count(key) ? std::atoi(a[key].c_str()) : d; };
  const int m = geti("m", 512), n = geti("n", 512), k = geti("k", 256), reps = geti("reps", 3);
  M A = M::Random(m, k), B = M::Random(k, n), C0 = M::Random(m, n);
  const double flops = 8.0 * m * n * k;  // real flops per complex GEMM
  // (1) Eigen
  M C = C0; double best_eigen = 1e30;
  for (int r = 0; r < reps; r++) { C = C0; double t0 = now_ms(); C.noalias() -= A * B; best_eigen = std::min(best_eigen, now_ms() - t0); }
  // split arrays
  std::vector<double> Ar(m * k), Ai(m * k), Br(k * n), Bi(k * n), Cr(m * n), Ci(m * n);
  for (int i = 0; i < m * k; i++) { Ar[i] = A.data()[i].real(); Ai[i] = A.data()[i].imag(); }
  for (int i = 0; i < k * n; i++) { Br[i] = B.data()[i].real(); Bi[i] = B.data()[i].imag(); }
  auto reset = [&]() { for (int i = 0; i < m * n; i++) { Cr[i] = C0.data()[i].real(); Ci[i] = C0.data()[i].imag(); } };
  double best_scalar = 1e30;
  for (int r = 0; r < reps; r++) { reset(); double t0 = now_ms(); gemm_split_scalar(m, n, k, Ar.data(), Ai.data(), Br.data(), Bi.data(), Cr.data(), Ci.data()); best_scalar = std::min(best_scalar, now_ms() - t0); }
  double err_scalar = 0; for (int i = 0; i < m * n; i++) err_scalar = std::max(err_scalar, std::abs(cd(Cr[i], Ci[i]) - C.data()[i]));
  double best_simd = -1, err_simd = 0;
#ifdef __wasm_simd128__
  best_simd = 1e30;
  for (int r = 0; r < reps; r++) { reset(); double t0 = now_ms(); gemm_split_simd(m, n, k, Ar.data(), Ai.data(), Br.data(), Bi.data(), Cr.data(), Ci.data()); best_simd = std::min(best_simd, now_ms() - t0); }
  for (int i = 0; i < m * n; i++) err_simd = std::max(err_simd, std::abs(cd(Cr[i], Ci[i]) - C.data()[i]));
#endif
  std::printf("m=%d n=%d k=%d eigen_ms=%.1f (%.2f GF/s) split_scalar_ms=%.1f (%.2f GF/s, err %.1e) split_simd_ms=%.1f (%.2f GF/s, err %.1e)\n",
    m, n, k, best_eigen, flops / best_eigen / 1e6, best_scalar, flops / best_scalar / 1e6, err_scalar,
    best_simd, best_simd > 0 ? flops / best_simd / 1e6 : 0, err_simd);
  return 0;
}
