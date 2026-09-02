/*
  Copyright (C) 2026  NEC2++ contributors

  Zero-copy view of a schema-1 NECF envelope. Planes match
  EmbeddedFarFieldResult: port-major eTheta/ePhi.
*/
use super::{load_f64_le, load_u32_le, load_u64_le};

pub const NECF_HEADER_BYTES: usize = 64;
pub const NECF_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NecfError {
    TooSmall,
    BadMagic,
    BadSchema,
    SizeMismatch,
}

#[derive(Debug, Clone, Copy)]
pub struct NecfView<'a> {
    pub packed: &'a [u8],
    pub schema_version: u32,
    pub n_ports: u32,
    pub n_theta: u32,
    pub n_phi: u32,
    pub samples_per_port: u32,
    pub frequency_mhz: f64,
    pub radius_m: f64,
    pub model_generation: u64,
    pub theta_deg: &'a [u8],
    pub phi_deg: &'a [u8],
    pub e_theta_real: &'a [u8],
    pub e_theta_imag: &'a [u8],
    pub e_phi_real: &'a [u8],
    pub e_phi_imag: &'a [u8],
}

pub fn packed_bytes(n_ports: usize, n_theta: usize, n_phi: usize) -> usize {
    let samples_per_port = n_theta * n_phi;
    NECF_HEADER_BYTES
        + (n_theta + n_phi + 4 * n_ports * samples_per_port) * 8
}

/// Zero-copy plane slices. Bind once; steering must not recopy this buffer.
pub fn view_embedded_field(packed: &[u8]) -> Result<NecfView<'_>, NecfError> {
    if packed.len() < NECF_HEADER_BYTES {
        return Err(NecfError::TooSmall);
    }
    if packed[0] != b'N' || packed[1] != b'E' || packed[2] != b'C' || packed[3] != b'F' {
        return Err(NecfError::BadMagic);
    }
    let schema_version = load_u32_le(packed, 4);
    if schema_version != NECF_SCHEMA_VERSION {
        return Err(NecfError::BadSchema);
    }
    let n_ports = load_u32_le(packed, 8) as usize;
    let n_theta = load_u32_le(packed, 12) as usize;
    let n_phi = load_u32_le(packed, 16) as usize;
    let samples_per_port = load_u32_le(packed, 20) as usize;
    if samples_per_port != n_theta * n_phi {
        return Err(NecfError::SizeMismatch);
    }
    let expected = packed_bytes(n_ports, n_theta, n_phi);
    if packed.len() != expected {
        return Err(NecfError::SizeMismatch);
    }
    let field_len = n_ports * samples_per_port;
    let mut offset = NECF_HEADER_BYTES;
    let theta_deg = &packed[offset..offset + n_theta * 8];
    offset += n_theta * 8;
    let phi_deg = &packed[offset..offset + n_phi * 8];
    offset += n_phi * 8;
    let e_theta_real = &packed[offset..offset + field_len * 8];
    offset += field_len * 8;
    let e_theta_imag = &packed[offset..offset + field_len * 8];
    offset += field_len * 8;
    let e_phi_real = &packed[offset..offset + field_len * 8];
    offset += field_len * 8;
    let e_phi_imag = &packed[offset..offset + field_len * 8];
    Ok(NecfView {
        packed,
        schema_version,
        n_ports: n_ports as u32,
        n_theta: n_theta as u32,
        n_phi: n_phi as u32,
        samples_per_port: samples_per_port as u32,
        frequency_mhz: load_f64_le(packed, 32),
        radius_m: load_f64_le(packed, 40),
        model_generation: load_u64_le(packed, 48),
        theta_deg,
        phi_deg,
        e_theta_real,
        e_theta_imag,
        e_phi_real,
        e_phi_imag,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_u32_le(bytes: &mut [u8], offset: usize, value: u32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn store_f64_le(bytes: &mut [u8], offset: usize, value: f64) {
        bytes[offset..offset + 8].copy_from_slice(&value.to_bits().to_le_bytes());
    }

    #[test]
    fn modest_grid_header_round_trip() {
        let n_ports = 1usize;
        let n_theta = 5usize;
        let n_phi = 3usize;
        let mut packed = vec![0u8; packed_bytes(n_ports, n_theta, n_phi)];
        packed[0..4].copy_from_slice(b"NECF");
        store_u32_le(&mut packed, 4, 1);
        store_u32_le(&mut packed, 8, n_ports as u32);
        store_u32_le(&mut packed, 12, n_theta as u32);
        store_u32_le(&mut packed, 16, n_phi as u32);
        store_u32_le(&mut packed, 20, (n_theta * n_phi) as u32);
        store_f64_le(&mut packed, 32, 300.0);
        store_f64_le(&mut packed, 40, 1.0);
        let view = view_embedded_field(&packed).expect("valid NECF");
        assert_eq!(view.n_ports, 1);
        assert_eq!(view.samples_per_port, 15);
        assert_eq!(view.theta_deg.len(), 40);
        assert_eq!(view.e_theta_real.len(), 15 * 8);
        assert_eq!(view.frequency_mhz, 300.0);
    }

    #[test]
    fn rejects_necq_magic() {
        let mut packed = vec![0u8; packed_bytes(1, 1, 1)];
        packed[0..4].copy_from_slice(b"NECQ");
        store_u32_le(&mut packed, 4, 1);
        store_u32_le(&mut packed, 8, 1);
        store_u32_le(&mut packed, 12, 1);
        store_u32_le(&mut packed, 16, 1);
        store_u32_le(&mut packed, 20, 1);
        assert!(matches!(
            view_embedded_field(&packed),
            Err(NecfError::BadMagic)
        ));
    }
}
