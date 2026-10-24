#[path = "../src/apply.rs"]
mod apply;
#[path = "../src/policy.rs"]
mod policy;

use std::path::PathBuf;

use landlock::{ABI, Access, AccessFs};
use policy::Policy;
use serde_json::json;

fn parse_policy(value: serde_json::Value) -> Result<Policy, String> {
    serde_json::from_value::<Policy>(value)
        .map_err(|error| error.to_string())
        .and_then(|policy| policy.validate())
}

#[test]
fn parses_a_full_policy() {
    let policy = parse_policy(json!({
        "ro": ["/usr", "/bin"],
        "rw": ["/tmp/work"],
        "minAbi": 6,
        "uid": 1000,
        "gid": 1001,
        "groups": [1001, 1002],
        "ensureDirs": ["/tmp/work"]
    }))
    .expect("full policy should parse");

    assert_eq!(
        policy.ro,
        vec![PathBuf::from("/usr"), PathBuf::from("/bin")]
    );
    assert_eq!(policy.rw, vec![PathBuf::from("/tmp/work")]);
    assert_eq!(policy.min_abi, 6);
    assert_eq!(policy.uid, Some(1000));
    assert_eq!(policy.gid, Some(1001));
    assert_eq!(policy.groups, Some(vec![1001, 1002]));
    assert_eq!(policy.ensure_dirs, vec![PathBuf::from("/tmp/work")]);
}

#[test]
fn ensure_dirs_defaults_to_empty() {
    let policy =
        parse_policy(json!({"ro": [], "rw": [], "minAbi": 1})).expect("ensureDirs is optional");
    assert!(policy.ensure_dirs.is_empty());
}

#[test]
fn rejects_an_ensure_dir_outside_rw() {
    let error = parse_policy(json!({
        "ro": ["/usr"],
        "rw": ["/tmp/work"],
        "minAbi": 1,
        "ensureDirs": ["/tmp/other"]
    }))
    .expect_err("every ensureDirs entry must be rw");
    assert!(error.contains("ensureDirs"), "unexpected error: {error}");
    assert!(error.contains("/tmp/other"), "unexpected error: {error}");
}

#[test]
fn rejects_a_relative_ensure_dir() {
    let error = parse_policy(json!({
        "ro": [],
        "rw": ["relative/path"],
        "minAbi": 1,
        "ensureDirs": ["relative/path"]
    }))
    .expect_err("ensureDirs paths must be absolute");
    assert!(error.contains("absolute"), "unexpected error: {error}");
}

#[test]
fn rejects_unknown_fields() {
    let error = serde_json::from_value::<Policy>(json!({
        "ro": [],
        "rw": [],
        "minAbi": 1,
        "unexpected": true
    }))
    .expect_err("unknown fields must be rejected");

    assert!(error.to_string().contains("unknown field"));
}

#[test]
fn rejects_root_ids() {
    for (field, value) in [("uid", json!(0)), ("gid", json!(0))] {
        let mut policy = json!({"ro": [], "rw": [], "minAbi": 1});
        policy[field] = value;
        let error = parse_policy(policy).expect_err("root ids must be rejected");
        assert!(error.contains(field), "unexpected error: {error}");
    }
}

#[test]
fn rejects_root_supplementary_groups() {
    let error = parse_policy(json!({
        "ro": [],
        "rw": [],
        "minAbi": 1,
        "groups": [1001, 0]
    }))
    .expect_err("root supplementary groups must be rejected");
    assert!(error.contains("group 0"), "unexpected error: {error}");
}

#[test]
fn rejects_a_path_in_both_ro_and_rw() {
    let error = parse_policy(json!({
        "ro": ["/tmp/shared"],
        "rw": ["/tmp/shared"],
        "minAbi": 1
    }))
    .expect_err("a path cannot be both read-only and read-write");

    assert!(
        error.contains("both ro and rw"),
        "unexpected error: {error}"
    );
}

#[test]
fn rejects_relative_paths() {
    for field in ["ro", "rw"] {
        let mut policy = json!({"ro": [], "rw": [], "minAbi": 1});
        policy[field] = json!(["relative/path"]);
        let error = parse_policy(policy).expect_err("paths must be absolute");
        assert!(error.contains("absolute"), "unexpected error: {error}");
    }
}

#[test]
fn rights_masks_match_the_contract() {
    let all = AccessFs::from_all(ABI::V7);
    let expected_ro = AccessFs::Execute | AccessFs::ReadFile | AccessFs::ReadDir;
    let expected_rw = expected_ro
        | AccessFs::WriteFile
        | AccessFs::RemoveFile
        | AccessFs::RemoveDir
        | AccessFs::MakeChar
        | AccessFs::MakeDir
        | AccessFs::MakeReg
        | AccessFs::MakeSock
        | AccessFs::MakeFifo
        | AccessFs::MakeBlock
        | AccessFs::MakeSym
        | AccessFs::Refer
        | AccessFs::Truncate;

    assert_eq!(apply::ro_access(), expected_ro);
    assert_eq!(apply::rw_access(), expected_rw);
    assert!(!apply::ro_access().contains(AccessFs::IoctlDev));
    assert!(!apply::rw_access().contains(AccessFs::IoctlDev));
    assert_eq!(apply::handled_access(ABI::V7), all & !AccessFs::IoctlDev);
}

#[test]
fn run_creates_ensure_dirs_with_private_mode() {
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after the epoch")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "sigrun-sandbox-ensure-{}-{unique}",
        std::process::id()
    ));
    let nested = root.join("nested/tmp");
    let output = Command::new(env!("CARGO_BIN_EXE_sigrun-sandbox"))
        .args(["run", "--", "/bin/true"])
        .env(
            "SIGRUN_SANDBOX_POLICY",
            serde_json::to_string(&json!({
                "ro": ["/usr", "/lib", "/lib64", "/bin"],
                "rw": [&nested],
                "minAbi": 0,
                "ensureDirs": [&nested]
            }))
            .expect("policy should serialize"),
        )
        .output()
        .expect("helper should return");
    let metadata = std::fs::metadata(&nested).expect("ensureDirs path should exist");
    let mode = metadata.permissions().mode() & 0o777;
    let _ = std::fs::remove_dir_all(&root);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.starts_with("sigrun-sandbox: Landlock ABI"),
            "directory creation must precede Landlock: {stderr}"
        );
    }
    assert!(metadata.is_dir());
    assert_eq!(mode, 0o700);
}

#[test]
fn ensure_dir_creation_failure_exits_125_without_exec() {
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after the epoch")
        .as_nanos();
    let file = std::env::temp_dir().join(format!(
        "sigrun-sandbox-ensure-file-{}-{unique}",
        std::process::id()
    ));
    std::fs::write(&file, "not a directory").expect("fixture file should be created");
    let nested = file.join("tmp");
    let output = Command::new(env!("CARGO_BIN_EXE_sigrun-sandbox"))
        .args(["run", "--", "/usr/bin/printf", "MUST_NOT_RUN"])
        .env(
            "SIGRUN_SANDBOX_POLICY",
            serde_json::to_string(&json!({
                "ro": ["/usr", "/lib", "/lib64", "/bin"],
                "rw": [nested],
                "minAbi": 0,
                "ensureDirs": [nested]
            }))
            .expect("policy should serialize"),
        )
        .output()
        .expect("helper should return");
    let _ = std::fs::remove_file(&file);
    assert_eq!(output.status.code(), Some(125));
    assert!(output.stdout.is_empty(), "command must not execute");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(stderr.lines().count(), 1, "unexpected stderr: {stderr}");
    assert!(
        stderr.starts_with("sigrun-sandbox:"),
        "unexpected stderr: {stderr}"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn run_refuses_an_abi_below_min_abi_without_executing() {
    use std::process::Command;

    let binary = env!("CARGO_BIN_EXE_sigrun-sandbox");
    let probe = Command::new(binary)
        .arg("probe")
        .output()
        .expect("probe should execute");
    assert!(probe.status.success());
    let probe: serde_json::Value =
        serde_json::from_slice(&probe.stdout).expect("probe should emit JSON");
    let abi = probe["abi"].as_u64().expect("probe should include an ABI");
    if abi >= 6 {
        eprintln!("skipping below-minimum ABI test: running kernel supports ABI {abi}, need < 6");
        return;
    }

    let output = Command::new(binary)
        .args(["run", "--", "/usr/bin/id", "-u"])
        .env(
            "SIGRUN_SANDBOX_POLICY",
            serde_json::to_string(&json!({
                "ro": ["/usr", "/lib", "/lib64", "/bin"],
                "rw": ["/tmp"],
                "minAbi": 6
            }))
            .expect("policy should serialize"),
        )
        .output()
        .expect("sandboxed command should return");

    assert_eq!(output.status.code(), Some(125));
    assert!(output.stdout.is_empty(), "command must not execute");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(stderr.lines().count(), 1, "unexpected stderr: {stderr}");
    assert!(stderr.starts_with("sigrun-sandbox:"));
    assert!(
        stderr.contains(&format!("ABI {abi}")),
        "unexpected stderr: {stderr}"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn run_denies_a_file_outside_the_policy() {
    use std::io::Write;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    let binary = env!("CARGO_BIN_EXE_sigrun-sandbox");
    let probe = Command::new(binary)
        .arg("probe")
        .output()
        .expect("probe should execute");
    assert!(probe.status.success());
    let probe: serde_json::Value =
        serde_json::from_slice(&probe.stdout).expect("probe should emit JSON");
    let abi = probe["abi"].as_u64().expect("probe should include an ABI");
    if abi < 6 {
        eprintln!(
            "skipping Landlock enforcement test: running kernel supports ABI {abi}, need >= 6"
        );
        return;
    }

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock should be after the epoch")
        .as_nanos();
    let denied = std::env::temp_dir().join(format!(
        "sigrun-sandbox-denied-{}-{unique}",
        std::process::id()
    ));
    let mut file = std::fs::File::create(&denied).expect("denied fixture should be created");
    writeln!(file, "not readable").expect("denied fixture should be written");
    drop(file);

    let output = Command::new(binary)
        .args(["run", "--", "/bin/cat"])
        .arg(&denied)
        .env(
            "SIGRUN_SANDBOX_POLICY",
            serde_json::to_string(&json!({
                "ro": ["/usr", "/lib", "/lib64", "/bin"],
                "rw": [],
                "minAbi": 6
            }))
            .expect("policy should serialize"),
        )
        .output()
        .expect("sandboxed cat should execute");
    let _ = std::fs::remove_file(&denied);

    assert!(
        !output.status.success(),
        "cat unexpectedly read the denied file: {}",
        String::from_utf8_lossy(&output.stdout)
    );
}
