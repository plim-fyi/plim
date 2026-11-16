//! A device signed in before 0.22.0 (its key locked with a device passphrase in device.json):
//! refused with what to do, and `plim logout` still signs it out. `plim remember` says it's gone.

use std::fs;
use std::process::Command;

#[test]
fn a_device_from_before_0_22_is_told_to_sign_in_again() {
    let home = std::env::temp_dir().join(format!("plim-credentials-{}", std::process::id()));
    fs::create_dir_all(home.join("config")).unwrap();
    // (As 0.21's device.json was: the seed locked in the file.)
    fs::write(
        home.join("config/device.json"),
        r#"{"server":"http://127.0.0.1:9","account_id":"acct","pubkey_hash":"aGFzaA==","salt":"c2FsdA==","nonce":"bm9uY2U=","ciphertext":"Y2lwaGVy","iterations":600000}"#,
    )
    .unwrap();
    let plim = |args: &[&str]| Command::new(env!("CARGO_BIN_EXE_plim")).args(args).env("PLIM_HOME", &home).env("PLIM_CREDENTIALS_STORE", "file").output().unwrap();

    let out = plim(&["ls"]);
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success());
    assert!(err.contains("before 0.22.0") && err.contains("plim logout") && err.contains("plim login"), "{err}");

    let out = plim(&["remember"]);
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success() && err.contains("plim remember is gone"), "{err}");

    let out = plim(&["logout"]);
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success() && err.contains("Signed out"), "{err}");
    assert!(!home.join("config/device.json").exists());
    fs::remove_dir_all(&home).unwrap();
}
