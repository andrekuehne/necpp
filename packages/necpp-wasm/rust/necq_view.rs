/*
  Copyright (C) 2026  NEC2++ contributors

  Sketch only: not a published crate. Matches nec_prepared_quadrature_view
  and the WP4 NECF envelope. Bind once; do not recopy on steering.
*/
#![allow(dead_code)]

mod necf_view;

pub use necf_view::{NecfError, NecfView};

pub const NECQ_HEADER_BYTES: usize = 64;
pub const NECQ_SCHEMA_VERSION: u32 = 1;
pub const NECQ_FLAG_IMAGES: u32 = 1;
pub const NECQ_FLAG_WEIGHTS: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NecqError {
    TooSmall,
    BadMagic,
    BadSchema,
    SizeMismatch,
}

#[derive(Debug, Clone, Copy)]
pub struct NecqView<'a> {
    pub packed: &'a [u8],
    pub schema_version: u32,
    pub flags: u32,
    pub n_segments: u32,
    pub n_nodes: u32,
    pub n_modes: u32,
    pub n_image_planes: u32,
    pub frequency_mhz: f64,
    pub wavelength_m: f64,
    pub model_generation: u64,
    pub solution_generation: u64,
    pub tag: &'a [u8],
    pub segment: &'a [u8],
    pub native_index: &'a [u8],
    pub x: &'a [u8],
    pub y: &'a [u8],
    pub z: &'a [u8],
    pub tx: &'a [u8],
    pub ty: &'a [u8],
    pub tz: &'a [u8],
    pub radius_m: &'a [u8],
    pub length_m: &'a [u8],
    pub ds_weight: &'a [u8],
    pub i_real: &'a [u8],
    pub i_imag: &'a [u8],
    pub geometry_count: usize,
    pub current_count: usize,
}

impl<'a> NecqView<'a> {
    pub fn has_images(&self) -> bool {
        (self.flags & NECQ_FLAG_IMAGES) != 0
    }

    pub fn has_weights(&self) -> bool {
        (self.flags & NECQ_FLAG_WEIGHTS) != 0
    }

    /// index = (plane * nSeg + segment) * nNodes + node
    pub fn geometry_index(&self, plane: usize, segment: usize, node: usize) -> Option<usize> {
        if plane >= self.n_image_planes as usize
            || segment >= self.n_segments as usize
            || node >= self.n_nodes as usize
        {
            return None;
        }
        Some((plane * self.n_segments as usize + segment) * self.n_nodes as usize + node)
    }

    /// index = ((mode * nImagePlanes + plane) * nSeg + segment) * nNodes + node
    pub fn current_index(
        &self,
        mode: usize,
        plane: usize,
        segment: usize,
        node: usize,
    ) -> Option<usize> {
        if mode >= self.n_modes as usize {
            return None;
        }
        let geometry = self.geometry_index(plane, segment, node)?;
        Some(
            mode * self.n_image_planes as usize * self.n_segments as usize * self.n_nodes as usize
                + geometry,
        )
    }
}

pub fn identity_bytes(n_segments: usize) -> usize {
    12 * n_segments
}

pub fn identity_pad_bytes(n_segments: usize) -> usize {
    let unpadded = NECQ_HEADER_BYTES + identity_bytes(n_segments);
    (8 - (unpadded % 8)) % 8
}

pub fn sample_count(n_segments: usize, n_nodes: usize, n_image_planes: usize) -> usize {
    n_segments * n_nodes * n_image_planes
}

pub fn packed_bytes(
    n_modes: usize,
    n_segments: usize,
    n_nodes: usize,
    n_image_planes: usize,
) -> usize {
    let geometry = sample_count(n_segments, n_nodes, n_image_planes);
    NECQ_HEADER_BYTES
        + identity_bytes(n_segments)
        + identity_pad_bytes(n_segments)
        + 9 * geometry * 8
        + 2 * n_modes * geometry * 8
}

pub(crate) fn load_u32_le(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

pub(crate) fn load_u64_le(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}

pub(crate) fn load_f64_le(bytes: &[u8], offset: usize) -> f64 {
    f64::from_bits(load_u64_le(bytes, offset))
}

fn f64_plane<'a>(bytes: &'a [u8], offset: usize, count: usize) -> &'a [u8] {
    &bytes[offset..offset + count * 8]
}

/// Zero-copy view of a schema-1 NECQ buffer. Slices alias `packed`.
pub fn view_prepared_quadrature(packed: &[u8]) -> Result<NecqView<'_>, NecqError> {
    if packed.len() < NECQ_HEADER_BYTES {
        return Err(NecqError::TooSmall);
    }
    if packed[0] != b'N' || packed[1] != b'E' || packed[2] != b'C' || packed[3] != b'Q' {
        return Err(NecqError::BadMagic);
    }
    let schema_version = load_u32_le(packed, 4);
    if schema_version != NECQ_SCHEMA_VERSION {
        return Err(NecqError::BadSchema);
    }
    let flags = load_u32_le(packed, 8);
    let n_segments = load_u32_le(packed, 12);
    let n_nodes = load_u32_le(packed, 16);
    let n_modes = load_u32_le(packed, 20);
    let n_image_planes = load_u32_le(packed, 24);
    let expected = packed_bytes(
        n_modes as usize,
        n_segments as usize,
        n_nodes as usize,
        n_image_planes as usize,
    );
    if packed.len() != expected {
        return Err(NecqError::SizeMismatch);
    }

    let identity_len = identity_bytes(n_segments as usize);
    let pad = identity_pad_bytes(n_segments as usize);
    let identity = &packed[NECQ_HEADER_BYTES..NECQ_HEADER_BYTES + identity_len];
    let i32_bytes = n_segments as usize * 4;
    let geometry_count = sample_count(
        n_segments as usize,
        n_nodes as usize,
        n_image_planes as usize,
    );
    let current_count = n_modes as usize * geometry_count;
    let geometry_offset = NECQ_HEADER_BYTES + identity_len + pad;
    let mut offset = geometry_offset;
    let x = f64_plane(packed, offset, geometry_count);
    offset += geometry_count * 8;
    let y = f64_plane(packed, offset, geometry_count);
    offset += geometry_count * 8;
    let z = f64_plane(packed, offset, geometry_count);
    offset += geometry_count * 8;
    let tx = f64_plane(packed, offset, geometry_count);
    offset += geometry_count * 8;
    let ty = f64_plane(packed, offset, geometry_count);
    offset += geometry_count * 8;
    let tz = f64_plane(packed, offset, geometry_count);
    offset += geometry_count * 8;
    let radius_m = f64_plane(packed, offset, geometry_count);
    offset += geometry_count * 8;
    let length_m = f64_plane(packed, offset, geometry_count);
    offset += geometry_count * 8;
    let ds_weight = f64_plane(packed, offset, geometry_count);
    offset += geometry_count * 8;
    let i_real = f64_plane(packed, offset, current_count);
    offset += current_count * 8;
    let i_imag = f64_plane(packed, offset, current_count);

    Ok(NecqView {
        packed,
        schema_version,
        flags,
        n_segments,
        n_nodes,
        n_modes,
        n_image_planes,
        frequency_mhz: load_f64_le(packed, 32),
        wavelength_m: load_f64_le(packed, 40),
        model_generation: load_u64_le(packed, 48),
        solution_generation: load_u64_le(packed, 56),
        tag: &identity[..i32_bytes],
        segment: &identity[i32_bytes..2 * i32_bytes],
        native_index: &identity[2 * i32_bytes..],
        x,
        y,
        z,
        tx,
        ty,
        tz,
        radius_m,
        length_m,
        ds_weight,
        i_real,
        i_imag,
        geometry_count,
        current_count,
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
    fn dipole_four_node_header_round_trip() {
        let n_seg = 11usize;
        let n_nodes = 4usize;
        let n_modes = 1usize;
        let n_planes = 1usize;
        let mut packed = vec![0u8; packed_bytes(n_modes, n_seg, n_nodes, n_planes)];
        packed[0..4].copy_from_slice(b"NECQ");
        store_u32_le(&mut packed, 4, 1);
        store_u32_le(&mut packed, 8, 0);
        store_u32_le(&mut packed, 12, n_seg as u32);
        store_u32_le(&mut packed, 16, n_nodes as u32);
        store_u32_le(&mut packed, 20, n_modes as u32);
        store_u32_le(&mut packed, 24, n_planes as u32);
        store_f64_le(&mut packed, 32, 300.0);
        store_f64_le(&mut packed, 40, 1.0);
        let view = view_prepared_quadrature(&packed).expect("valid NECQ");
        assert_eq!(view.n_segments, 11);
        assert_eq!(view.n_nodes, 4);
        assert_eq!(view.geometry_index(0, 5, 2), Some((5 * 4) + 2));
        assert_eq!(view.current_index(0, 0, 5, 2), Some((5 * 4) + 2));
        assert_eq!(view.frequency_mhz, 300.0);
        assert!(!view.has_images());
    }

    #[test]
    fn rejects_necf_magic() {
        let mut packed = vec![0u8; packed_bytes(1, 1, 1, 1)];
        packed[0..4].copy_from_slice(b"NECF");
        store_u32_le(&mut packed, 4, 1);
        store_u32_le(&mut packed, 12, 1);
        store_u32_le(&mut packed, 16, 1);
        store_u32_le(&mut packed, 20, 1);
        store_u32_le(&mut packed, 24, 1);
        assert!(matches!(
            view_prepared_quadrature(&packed),
            Err(NecqError::BadMagic)
        ));
    }
}
