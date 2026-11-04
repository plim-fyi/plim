//! Signup proof-of-work: find `nonce` such that SHA-256(salt || nonce_u64_be)
//! has at least `difficulty` leading zero bits.

use sha2::{Digest, Sha256};

pub fn leading_zero_bits(hash: &[u8]) -> u32 {
    let mut bits = 0;
    for &b in hash {
        if b == 0 {
            bits += 8;
        } else {
            return bits + b.leading_zeros();
        }
    }
    bits
}

fn passes(salted: &Sha256, nonce: u64, difficulty: u32) -> bool {
    leading_zero_bits(&salted.clone().chain_update(nonce.to_be_bytes()).finalize()) >= difficulty
}

pub fn check(salt: &[u8], nonce: u64, difficulty: u32) -> bool {
    passes(&Sha256::new_with_prefix(salt), nonce, difficulty)
}

/// Brute-force a solution (used by clients at signup: the web app's, compiled
/// to WebAssembly, in crates/plim-wasm).
pub fn solve(salt: &[u8], difficulty: u32) -> u64 {
    let salted = Sha256::new_with_prefix(salt);
    (0..).find(|&n| passes(&salted, n, difficulty)).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_bits() {
        assert_eq!(leading_zero_bits(&[0, 0, 0x10]), 19);
        assert_eq!(leading_zero_bits(&[0x80]), 0);
    }

    #[test]
    fn solve_and_check() {
        let salt = [3u8; 16];
        let n = solve(&salt, 12);
        assert!(check(&salt, n, 12));
        assert!(!check(&salt, n, 40));
    }
}
