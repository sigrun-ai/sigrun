# sigrun-sandbox

`sigrun-sandbox` is sigrun's native per-user execution helper. It applies the
requested identity transition, `no_new_privs`, and a Landlock policy, then
replaces itself with the requested command. It never executes a command after a
policy failure. The source forbids unsafe Rust.

## Build and install

Build the host binary with a stable Rust toolchain:

```sh
cargo build --release
install -m 0755 target/release/sigrun-sandbox /usr/local/bin/sigrun-sandbox
```

Release builds use link-time optimization and abort on panic. Static musl
binaries for Linux are built for these targets (a suitable musl linker and
Rust target must be installed):

```sh
cargo build --release --target x86_64-unknown-linux-musl
cargo build --release --target aarch64-unknown-linux-musl
```

The resulting binaries are at
`target/<target>/release/sigrun-sandbox`. Install the binary for the host
architecture on `PATH` as `sigrun-sandbox`. sigrun core invokes this installed
helper for each per-user worker; there is no Node package entry point.

To opt in to `osUser` mappings on bare metal, grant the installed helper only
the two identity-switch capabilities (replace `<helper>` with its path):

```sh
sudo setcap cap_setuid,cap_setgid+ep <helper>
```

Containers do not use this mapping: their entrypoint drops every capability.

## Interface

Report the running kernel's Landlock ABI as one JSON line (`0` means Landlock
is unavailable), exiting successfully:

```sh
sigrun-sandbox probe
# {"abi":6}
```

Run a confined command:

```sh
SIGRUN_SANDBOX_POLICY='{"ro":["/usr","/bin","/lib","/lib64"],"rw":["/tmp/work"],"minAbi":6,"uid":1000,"gid":1000,"groups":[1000]}' \
  sigrun-sandbox run -- /usr/bin/id
```

The policy has this JSON shape:

```json
{
  "ro": ["/absolute/read-only/path"],
  "rw": ["/absolute/read-write/path"],
  "minAbi": 6,
  "uid": 1000,
  "gid": 1000,
  "groups": [1000],
  "ensureDirs": ["/tmp/work/tmp"]
}
```

`uid`, `gid`, and `groups` are optional. `ensureDirs` is optional and defaults
to an empty list; every entry must be absolute and also appear in `rw`. After
the identity switch and before Landlock is applied, the helper creates those
directories recursively with mode 0700, so a mapped OS account owns its tmp
directory. Root uid or gid is rejected. Paths must be absolute and cannot
appear in both lists. Nonexistent paths are noted on stderr and skipped.
Unknown fields are rejected.

The helper reads `SIGRUN_SANDBOX_POLICY`, removes it from the environment, and
leaves the rest of the environment unchanged before `exec`. If `groups` is
present it calls `setgroups`, then applies the optional gid and uid, in that
order; changing identity may require appropriate starting privileges. It sets
`PR_SET_NO_NEW_PRIVS`, handles all filesystem rights supported by the running
ABI except `IOCTL_DEV`, adds the path rules, scopes signals and abstract Unix
sockets, and enforces the ruleset. The running ABI is checked against `minAbi`
first: a lower ABI is fatal and the diagnostic names it. Full enforcement of
the handled rights is then required regardless of `minAbi`.

Every failure before `exec` emits one `sigrun-sandbox:` diagnostic on stderr
and exits 125. Successful `run` never returns: it is replaced by the command,
which determines its own output and exit status.

## Kernel boundary verification

A local run on this host (Linux, Landlock ABI 7) passed the 19 unprivileged
cases in `test/sandbox-it/boundary.test.ts`. The hosted-CI boundary run is
**pending**; no post-change hosted-CI result is claimed. Two cases need more
privilege than CI grants: the `osUser` success case and the case proving that
the same helper's uid/gid switch succeeds outside a jail and fails inside it.
Both **pass** under `SIGRUN_SANDBOX_IT_PRIVILEGED=1` with a privileged runner
(all 21 cases green). They are operator-verified rather than CI-verified,
because no hosted job grants the identity-switch capabilities.

Running them needs the fixture's own prerequisites, which are easy to get
wrong and which previously made the cases look unverifiable:

- the target's **ancestor directories must be traversable** by the
  switched-to uid (`mkdtemp` is mode 0700, and the jail switches uid before
  `execve`, so an untraversable root fails with `EACCES` before the policy is
  consulted);
- the exec target must be a **non-capped** binary, as production always has
  (`launchInJail` execs `node`); pointing the target at the capped helper made
  it exec its own capped self;
- the `osUser` account's home must **not be the managed root** that contains
  `configDir`, and the switched-to uid needs write access to create the
  policy's `ensureDirs`.

`scripts/verify-sandbox-privileged.sh` runs both cases without creating a
broadly privileged workload. It uses a disposable Docker-compatible container
as root, drops every capability, and adds back only `SETFCAP`, `SETUID`, and
`SETGID`. `SETFCAP` permits setting the helper's file-capability xattr, while
the other two must be present in the process bounding set for `execve` of the
file-capability-carrying helper to succeed. The container receives neither
`SYS_ADMIN` nor the `privileged` flag. Docker's
default seccomp profile is disabled for this disposable container because the
suite's namespace control requires `unshare`; this does not widen its capability
set. The script then runs exactly those two cases with
`SIGRUN_SANDBOX_IT_PRIVILEGED=1`, followed by the ordinary suite with that
opt-in unset as a regression check.

A dry run is the default and creates nothing:

```sh
scripts/verify-sandbox-privileged.sh
```

An actual run needs an explicit `--run`, a full core commit, and a
digest-pinned image containing Node 22, `setcap`, `ps` (from `procps`), and
the sandbox helper at `/usr/local/lib/sigrun/sigrun-sandbox`:

```sh
SIGRUN_SANDBOX_VERIFY_IMAGE='IMAGE@sha256:64-lowercase-hex-digest' \
  scripts/verify-sandbox-privileged.sh --run 40-lowercase-hex-commit
```

The core checkout must contain that commit, and the five built-in extension
checkouts must be its siblings in the same parent directory. The script
archives the requested core commit and each sibling's current `HEAD`, printing
every source revision so a completed run records the exact dependency set it
tested. `SIGRUN_SANDBOX_VERIFY_RUNTIME` selects the container
runtime executable (default `docker`); Docker's usual `DOCKER_HOST` selects the
target daemon. The runner needs network access for `npm ci`, Linux with
Landlock ABI 6 or newer, and support for unprivileged user and PID namespaces.

The run emits the kernel release, Landlock ABI, and per-case results. With the
current fixture, both privileged cases are expected to **FAIL** for the reasons
recorded in the 2026-10-27 release verification evidence. A green result
requires the fixture redesign. The script does not tolerate those failures: it
exits non-zero if either privileged case fails, if the ordinary suite
regresses, or if the ABI is too old. A trap removes the container and temporary
source archive on success or failure. Running the script is an operator action;
the dry run is not evidence that either privileged case passed.
