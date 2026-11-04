//! The web app's WebAssembly (web/wasm/plim.wasm, built by tools/wasm/build.sh).
//!
//! A plain C ABI, no bindings generator: the page passes bytes by writing them
//! into memory it got from `alloc_bytes`, and frees them with `free_bytes`. Loaded by
//! web/core/wasm.js; each export here has its JS wrapper there.

use std::alloc::{Layout, alloc as raw_alloc, dealloc};

/// `len` bytes for the page to write arguments into (null if `len` is 0).
#[unsafe(no_mangle)]
pub extern "C" fn alloc_bytes(len: usize) -> *mut u8 {
    match Layout::array::<u8>(len) {
        Ok(layout) if len > 0 => unsafe { raw_alloc(layout) },
        _ => std::ptr::null_mut(),
    }
}

/// Give back what `alloc_bytes(len)` returned.
///
/// # Safety
/// `ptr` must come from `alloc_bytes(len)` with the same `len`, and be freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn free_bytes(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        unsafe { dealloc(ptr, Layout::array::<u8>(len).unwrap()) }
    }
}

/// The hardest proof-of-work the page will try; as pow-worker.js's JS solver.
pub const POW_MAX_DIFFICULTY: u32 = 48;

/// Signup's proof-of-work (plim_core::pow): the first nonce whose
/// SHA-256(salt ‖ u64be(nonce)) has `difficulty` leading zero bits, or
/// u64::MAX if `difficulty` is over POW_MAX_DIFFICULTY.
///
/// # Safety
/// `salt` must point to `salt_len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pow_solve(salt: *const u8, salt_len: usize, difficulty: u32) -> u64 {
    if difficulty > POW_MAX_DIFFICULTY {
        return u64::MAX;
    }
    let salt = if salt_len == 0 { &[][..] } else { unsafe { std::slice::from_raw_parts(salt, salt_len) } };
    plim_core::pow::solve(salt, difficulty)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solves_as_plim_core_checks() {
        let salt = [7u8; 16];
        let p = alloc_bytes(16);
        unsafe { std::slice::from_raw_parts_mut(p, 16).copy_from_slice(&salt) };
        let n = unsafe { pow_solve(p, 16, 12) };
        unsafe { free_bytes(p, 16) };
        assert!(plim_core::pow::check(&salt, n, 12));
        assert_eq!(n, plim_core::pow::solve(&salt, 12));
    }

    #[test]
    fn refuses_too_hard() {
        assert_eq!(unsafe { pow_solve(std::ptr::null(), 0, POW_MAX_DIFFICULTY + 1) }, u64::MAX);
    }
}
