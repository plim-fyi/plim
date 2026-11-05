//! `plim uninstall` (README, Terminal client): everything of plim's goes, the program included;
//! nothing else does. Run on a copy of the binary, with PLIM_HOME in a folder of its own.

use std::fs;
use std::process::Command;

#[test]
fn uninstall_removes_config_data_scratch_and_the_program_itself() {
    let dir = std::env::temp_dir().join(format!("plim-uninstall-{}", std::process::id()));
    let (home, runtime, bin) = (dir.join("home"), dir.join("run"), dir.join("bin"));
    for d in [home.join("config"), home.join("data/tmp"), runtime.join("plim"), bin.clone(), dir.join("other")] {
        fs::create_dir_all(&d).unwrap();
    }
    fs::write(home.join("config/device.json"), "{}").unwrap(); // (not a device plim can load: fine, it's just removed)
    fs::write(home.join("data/acct.db"), "x").unwrap();
    fs::write(runtime.join("plim/note-abc.md"), "a note being edited").unwrap();
    fs::write(dir.join("other/keep.txt"), "not plim's").unwrap();
    let exe = bin.join("plim");
    fs::copy(env!("CARGO_BIN_EXE_plim"), &exe).unwrap();

    // Not a terminal, no --yes: refused, nothing removed.
    let out = Command::new(&exe).arg("uninstall").env("PLIM_HOME", &home).env("XDG_RUNTIME_DIR", &runtime).output().unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("--yes"));
    assert!(exe.exists() && home.join("config/device.json").exists());

    let out = Command::new(&exe).args(["uninstall", "--yes"]).env("PLIM_HOME", &home).env("XDG_RUNTIME_DIR", &runtime).output().unwrap();
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "{err}");
    assert!(err.contains("its config") && err.contains("its data") && err.contains("its scratch folder") && err.contains("the program"), "{err}");
    assert!(err.contains("Removed."), "{err}");
    for gone in [home.join("config"), home.join("data"), runtime.join("plim"), exe] {
        assert!(!gone.exists(), "{} should be gone", gone.display());
    }
    assert!(dir.join("other/keep.txt").exists(), "nothing else is touched");
    fs::remove_dir_all(&dir).unwrap();
}
