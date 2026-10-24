#![forbid(unsafe_code)]

mod apply;
mod native_probe;
mod policy;

use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::process::{Command, ExitCode};

use nix::sys::prctl::set_no_new_privs;
use nix::unistd::{Gid, Uid, setgroups, setresgid, setresuid};
use policy::Policy;

const POLICY_ENV: &str = "SIGRUN_SANDBOX_POLICY";

fn main() -> ExitCode {
    match dispatch(std::env::args_os().skip(1).collect()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("sigrun-sandbox: {error}");
            ExitCode::from(125)
        }
    }
}

fn dispatch(args: Vec<OsString>) -> Result<(), String> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("probe") if args.len() == 1 => {
            println!("{{\"abi\":{}}}", apply::probe());
            Ok(())
        }
        Some("probe") => {
            let args = args[1..]
                .iter()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            native_probe::dispatch(&args).map(|_| ())
        }
        Some("run") => run(&args[1..]),
        _ => Err("usage: sigrun-sandbox probe | run -- <command> [args…]".to_owned()),
    }
}

fn run(args: &[OsString]) -> Result<(), String> {
    let Some(command) = args.strip_prefix(std::slice::from_ref(&OsString::from("--"))) else {
        return Err("run requires -- followed by a command".to_owned());
    };
    let Some((program, command_args)) = command.split_first() else {
        return Err("run requires a command after --".to_owned());
    };

    let policy =
        std::env::var(POLICY_ENV).map_err(|error| format!("cannot read {POLICY_ENV}: {error}"))?;
    let policy = serde_json::from_str::<Policy>(&policy)
        .map_err(|error| format!("invalid {POLICY_ENV}: {error}"))?
        .validate()?;

    if let Some(groups) = &policy.groups {
        let groups = groups
            .iter()
            .copied()
            .map(Gid::from_raw)
            .collect::<Vec<_>>();
        setgroups(&groups).map_err(|error| format!("cannot set supplementary groups: {error}"))?;
    }
    if let Some(gid) = policy.gid {
        let gid = Gid::from_raw(gid);
        setresgid(gid, gid, gid).map_err(|error| format!("cannot set gid: {error}"))?;
    }
    if let Some(uid) = policy.uid {
        let uid = Uid::from_raw(uid);
        setresuid(uid, uid, uid).map_err(|error| format!("cannot set uid: {error}"))?;
    }
    for path in &policy.ensure_dirs {
        std::fs::create_dir_all(path).map_err(|error| {
            format!("cannot create ensureDirs path {}: {error}", path.display())
        })?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(
            |error| format!("cannot set ensureDirs mode on {}: {error}", path.display()),
        )?;
    }
    set_no_new_privs().map_err(|error| format!("cannot set no_new_privs: {error}"))?;

    apply::apply(&policy)?;
    let error = Command::new(program)
        .args(command_args)
        .env_remove(POLICY_ENV)
        .exec();
    Err(format!(
        "cannot exec {}: {error}",
        program.to_string_lossy()
    ))
}
