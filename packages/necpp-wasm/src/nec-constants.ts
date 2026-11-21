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

/** NEC's pi (math_util.h), 1.6e-11 relative above the exact value. */
const NEC_PI = 3.1415926536;

/**
 * The wavenumber of the periodic kernel in rad/m: two of NEC's pi per
 * wavelength. A Floquet mode is at cut-off where its transverse wavevector
 * (from the scan phases with the exact pi) reaches it, so directions near
 * the horizon or a Wood circle need this one rather than `necWavenumberPerM`.
 */
export function necPeriodicWavenumberPerM(frequencyMHz: number): number {
  return 2 * NEC_PI * frequencyMHz * 1e6 / NEC_SPEED_OF_LIGHT_M_PER_S;
}

/**
 * The free-space field impedance of NEC's thin-wire kernel in ohms: its
 * prefactor j 4.771341189 is j eta / (8 pi^2). The Floquet amplitudes are
 * normalized to power with it.
 */
export const NEC_FIELD_IMPEDANCE_OHM = 4.771341189 * 8 * Math.PI * Math.PI;
