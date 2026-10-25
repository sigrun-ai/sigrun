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
