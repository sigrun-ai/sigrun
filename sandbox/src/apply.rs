use std::path::Path;

use landlock::{
    ABI, Access, AccessFs, BitFlags, PathBeneath, PathFd, Ruleset, RulesetAttr, RulesetCreatedAttr,
    RulesetStatus, Scope,
};

use crate::policy::Policy;

#[allow(dead_code, reason = "called by the probe subcommand")]
pub fn probe() -> u32 {
    // This subcommand exits immediately. `run` never calls this helper: it reads
    // the ABI from its one real policy restriction instead.
    Ruleset::default()
        .handle_access(AccessFs::from_all(ABI::V1))
        .and_then(|ruleset| ruleset.create())
        .and_then(|ruleset| ruleset.restrict_self())
        .map(|status| ABI::from(status.landlock) as u32)
        .unwrap_or(0)
}

pub fn ro_access() -> BitFlags<AccessFs> {
    AccessFs::Execute | AccessFs::ReadFile | AccessFs::ReadDir
}

pub fn rw_access() -> BitFlags<AccessFs> {
    ro_access()
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
        | AccessFs::Truncate
}

pub fn handled_access(abi: ABI) -> BitFlags<AccessFs> {
    AccessFs::from_all(abi) & !AccessFs::IoctlDev
}

#[allow(dead_code, reason = "called by the binary entry point")]
pub fn apply(policy: &Policy) -> Result<u32, String> {
    let ruleset = Ruleset::default()
        .handle_access(handled_access(ABI::V7))
        .map_err(|error| format!("cannot handle filesystem rights: {error}"))?
        .scope(Scope::Signal | Scope::AbstractUnixSocket)
        .map_err(|error| format!("cannot scope the ruleset: {error}"))?
        .create()
        .map_err(|error| format!("cannot create the ruleset: {error}"))?;
    let ruleset = add_paths(ruleset, &policy.ro, ro_access())?;
    let ruleset = add_paths(ruleset, &policy.rw, rw_access())?;
    let status = ruleset
        .restrict_self()
        .map_err(|error| format!("cannot restrict this process: {error}"))?;
    let abi = ABI::from(status.landlock) as u32;
    if abi < policy.min_abi {
        return Err(format!(
            "Landlock ABI {abi} is below minimum ABI {}",
            policy.min_abi
        ));
    }
    if status.ruleset != RulesetStatus::FullyEnforced {
        return Err(format!(
            "Landlock ABI {abi} did not fully enforce the handled filesystem rights (minimum ABI {})",
            policy.min_abi
        ));
    }
    Ok(abi)
}

#[allow(dead_code, reason = "called by apply")]
fn add_paths(
    mut ruleset: landlock::RulesetCreated,
    paths: &[std::path::PathBuf],
    access: BitFlags<AccessFs>,
) -> Result<landlock::RulesetCreated, String> {
    for path in paths {
        match PathFd::new(path) {
            Ok(fd) => {
                ruleset = ruleset
                    .add_rule(PathBeneath::new(fd, access))
                    .map_err(|error| format!("cannot allow {}: {error}", path.display()))?;
            }
            Err(landlock::PathFdError::OpenCall { source, .. })
                if source.kind() == std::io::ErrorKind::NotFound =>
            {
                eprintln!(
                    "sigrun-sandbox: skipping nonexistent path {}",
                    Path::new(path).display()
                );
            }
            Err(error) => return Err(format!("cannot open {}: {error}", path.display())),
        }
    }
    Ok(ruleset)
}
