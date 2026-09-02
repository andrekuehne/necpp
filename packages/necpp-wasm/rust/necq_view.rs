/*
  Copyright (C) 2026  NEC2++ contributors

  Zero-copy NECQ/NECF views. Matches nec_prepared_quadrature_view and the
  WP4 NECF envelope. Bind once against published fixtures; do not recopy
  on steering. Not a published crate.
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

    pub fn f64_at(plane: &[u8], index: usize) -> Option<f64> {
        let offset = index.checked_mul(8)?;
        let bytes = plane.get(offset..offset + 8)?;
        Some(f64::from_le_bytes(bytes.try_into().ok()?))
    }

    pub fn i32_at(plane: &[u8], index: usize) -> Option<i32> {
        let offset = index.checked_mul(4)?;
        let bytes = plane.get(offset..offset + 4)?;
        Some(i32::from_le_bytes(bytes.try_into().ok()?))
    }

    pub fn position_m(&self, plane: usize, segment: usize, node: usize) -> Option<(f64, f64, f64)> {
        let index = self.geometry_index(plane, segment, node)?;
        Some((
            Self::f64_at(self.x, index)?,
            Self::f64_at(self.y, index)?,
            Self::f64_at(self.z, index)?,
        ))
    }

    pub fn tangent(&self, plane: usize, segment: usize, node: usize) -> Option<(f64, f64, f64)> {
        let index = self.geometry_index(plane, segment, node)?;
        Some((
            Self::f64_at(self.tx, index)?,
            Self::f64_at(self.ty, index)?,
            Self::f64_at(self.tz, index)?,
        ))
    }

    pub fn current(&self, mode: usize, plane: usize, segment: usize, node: usize) -> Option<(f64, f64)> {
        let index = self.current_index(mode, plane, segment, node)?;
        Some((
            Self::f64_at(self.i_real, index)?,
            Self::f64_at(self.i_imag, index)?,
        ))
    }

    pub fn ds_weight_at(&self, plane: usize, segment: usize, node: usize) -> Option<f64> {
        Self::f64_at(self.ds_weight, self.geometry_index(plane, segment, node)?)
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

    fn aliases_packed(packed: &[u8], plane: &[u8]) {
        let start = packed.as_ptr() as usize;
        let end = start + packed.len();
        let plane_start = plane.as_ptr() as usize;
        let plane_end = plane_start + plane.len();
        assert!(plane_start >= start && plane_end <= end);
    }

    #[test]
    fn dipole_fixture_binds_metres_tangents_and_weighted_currents() {
        let packed: &[u8] = include_bytes!("../fixtures/current-quadrature-v1/dipole.necq");
        let view = view_prepared_quadrature(packed).expect("valid dipole NECQ");
        assert_eq!(view.n_segments, 11);
        assert_eq!(view.n_nodes, 4);
        assert_eq!(view.n_modes, 1);
        assert_eq!(view.n_image_planes, 1);
        assert!((view.frequency_mhz - 300.0).abs() < 1e-12);
        aliases_packed(packed, view.x);
        aliases_packed(packed, view.i_real);

        let (x, y, z) = view.position_m(0, 0, 0).expect("start sample");
        assert!((x).abs() < 1e-12);
        assert!((y).abs() < 1e-12);
        assert!((z + 0.25).abs() < 1e-9);
        let (tx, ty, tz) = view.tangent(0, 0, 0).expect("tangent");
        assert!((tx).abs() < 1e-12);
        assert!((ty).abs() < 1e-12);
        assert!((tz - 1.0).abs() < 1e-12);
        let weight = view.ds_weight_at(0, 0, 0).expect("weight");
        let length = 0.5 / 11.0;
        assert!((weight - length / 2.0).abs() < 1e-12);

        let (re, im) = view.current(0, 0, 5, 0).expect("feed sample");
        assert!((re - 0.9984886099846924).abs() < 1e-12);
        assert!((im + 0.012421139423889116).abs() < 1e-12);

        let bound = view_prepared_quadrature(packed).expect("second bind");
        assert_eq!(bound.x.as_ptr(), view.x.as_ptr());
        assert_eq!(bound.i_real.as_ptr(), view.i_real.as_ptr());
        let _steer = bound.current(0, 0, 5, 2);
        assert_eq!(bound.i_imag.as_ptr(), view.i_imag.as_ptr());
    }

    #[test]
    fn monopole_image_fixture_keeps_planes_separate() {
        let packed: &[u8] =
            include_bytes!("../fixtures/current-quadrature-v1/rooted-monopole-images.necq");
        let view = view_prepared_quadrature(packed).expect("valid image NECQ");
        assert_eq!(view.n_image_planes, 2);
        assert!(view.has_images());
        for segment in 0..view.n_segments as usize {
            for node in 0..view.n_nodes as usize {
                let physical = view.position_m(0, segment, node).unwrap();
                let image = view.position_m(1, segment, node).unwrap();
                assert!((image.0 - physical.0).abs() < 1e-12);
                assert!((image.1 - physical.1).abs() < 1e-12);
                assert!((image.2 + physical.2).abs() < 1e-12);
                let physical_t = view.tangent(0, segment, node).unwrap();
                let image_t = view.tangent(1, segment, node).unwrap();
                assert!((image_t.2 + physical_t.2).abs() < 1e-12);
                let physical_i = view.current(0, 0, segment, node).unwrap();
                let image_i = view.current(0, 1, segment, node).unwrap();
                assert!((image_i.0 + physical_i.0).abs() < 1e-12);
                assert!((image_i.1 + physical_i.1).abs() < 1e-12);
            }
        }
    }

    #[test]
    fn bind_once_steer_does_not_clone_planes() {
        use std::time::Instant;

        let necq: &[u8] = include_bytes!("../fixtures/current-quadrature-v1/dipole.necq");
        let necf: &[u8] = include_bytes!("../fixtures/current-quadrature-v1/dipole.necf");
        let current = view_prepared_quadrature(necq).expect("NECQ");
        let field = crate::necf_view::view_embedded_field(necf).expect("NECF");
        let current_ptr = current.i_real.as_ptr();
        let field_ptr = field.e_theta_real.as_ptr();

        let started = Instant::now();
        let mut sink = 0.0;
        for _ in 0..10_000 {
            let bound = view_prepared_quadrature(necq).expect("steer NECQ");
            let rebound = crate::necf_view::view_embedded_field(necf).expect("steer NECF");
            assert_eq!(bound.i_real.as_ptr(), current_ptr);
            assert_eq!(rebound.e_theta_real.as_ptr(), field_ptr);
            let sample = bound.current(0, 0, 5, 2).expect("current");
            let e_theta = rebound.e_theta(0, 1, 1).expect("field");
            sink += sample.0 + e_theta.0;
        }
        let steer_ms = started.elapsed().as_secs_f64() * 1_000.0 / 10_000.0;
        assert!(sink.is_finite());

        let evidence = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../bench/evidence/current-quadrature-wp6/rust-bind.json");
        if let Some(parent) = evidence.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let body = format!(
            "{{\n  \"type\": \"current-quadrature-wp6-rust-bind\",\n  \"schemaVersion\": 1,\n  \"necqBytes\": {},\n  \"necfBytes\": {},\n  \"steerMsPerBind\": {:.6},\n  \"clonedPlanes\": false\n}}\n",
            necq.len(),
            necf.len(),
            steer_ms,
        );
        std::fs::write(&evidence, body).expect("write rust bind evidence");
    }

    #[test]
    fn optional_visualizer_checkout_does_not_fail_when_absent() {
        let from_env = std::env::var_os("NECPP_VISUALIZER_ROOT");
        let sibling = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../PhasedArrayVisualizer-NG");
        let _present = from_env.is_some() || sibling.exists();
    }
}
