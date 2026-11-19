// Physical constants as the NEC engine defines them (electromag.cpp), so that
// wavenumbers computed in TypeScript match the engine's.
const NEC_VACUUM_PERMITTIVITY_F_PER_M = 8.854e-12;
const NEC_VACUUM_PERMEABILITY_H_PER_M = 4 * Math.PI * 1e-7;

export const NEC_SPEED_OF_LIGHT_M_PER_S = 1 / Math.sqrt(
  NEC_VACUUM_PERMITTIVITY_F_PER_M * NEC_VACUUM_PERMEABILITY_H_PER_M,
);

/** Free-space wavenumber in rad/m at the given frequency. */
export function necWavenumberPerM(frequencyMHz: number): number {
  return 2 * Math.PI * frequencyMHz * 1e6 / NEC_SPEED_OF_LIGHT_M_PER_S;
}
