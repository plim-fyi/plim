//! The server's settings: `PLIM_<name>`, else the name they had before the rename, `TIRO_<name>`
//! (production's service still sets those).

use plim_server::env;

#[test]
fn settings_read_plim_then_tiro() {
    // (Names no other test reads, so setting them can't race another test.)
    // SAFETY: only this test touches these variables.
    unsafe {
        std::env::set_var("TIRO_ENV_TEST_OLD", "old");
        std::env::set_var("PLIM_ENV_TEST_BOTH", "new");
        std::env::set_var("TIRO_ENV_TEST_BOTH", "old");
    }
    assert_eq!(env("ENV_TEST_OLD").as_deref(), Some("old"), "the old name alone still works");
    assert_eq!(env("ENV_TEST_BOTH").as_deref(), Some("new"), "the new name wins");
    assert_eq!(env("ENV_TEST_UNSET"), None);
}
