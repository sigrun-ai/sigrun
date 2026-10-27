#!/bin/sh
# sigrun container entrypoint — the privilege-drop trampoline (image
# workflow spec §1, UID posture).
#
# The image's `USER 1000:1000` is a DEFAULT, not a requirement: rootless
# runtimes pass their own uid (`docker run --user`, a pod's
# securityContext.runAsUser) and must work verbatim. Exactly two paths:
#
# - started as root (a plain `docker run` with no --user): fix the
#   ownership of the two MOUNT POINTS, then drop to $SG_UID:$SG_GID via
#   setpriv (ships in util-linux; no gosu/su-exec package needed) and
#   exec the command. Only the mount points themselves are chowned —
#   never `chown -R`, which on a populated data volume blocks boot for
#   minutes and rewrites files the app already owns (a fresh volume
#   inherits the image dir's ownership; an existing one is already the
#   app's).
# - started non-root: exec immediately, no chown attempted (it would
#   fail; the runtime that chose the uid owns the volume-permission
#   story — k8s fsGroup, compose volume inheritance). Zero overhead on
#   the k8s path.
#
# HOME is set here on BOTH paths, because Docker cannot get it right: it
# derives HOME from the runtime uid's passwd entry, so any uid the image
# has no entry for receives "/" — unwritable — and sigrun's tier-3 store
# roots are homedir()-relative (`~/.config/sigrun`,
# `~/.local/share/sigrun`, ...), so boot would mkdir '/.local' and die
# with EACCES. See HOME below.
set -eu

# The uid/gid a root start drops to. Defaults match the image's USER;
# env-overridable so an operator can shift sigrun onto an existing site
# uid without an image rebuild.
SG_UID="${SG_UID:-1000}"
SG_GID="${SG_GID:-1000}"

# The process home. Defaults onto the DATA volume rather than the image
# layer (/home/node): that path is writable under `read_only: true`,
# survives a container restart, and sits on the same volume as the app's
# own state. SIGRUN_HOME overrides it — deliberately its own knob, never
# derived from SIGRUN_CONFIG_DIR / SIGRUN_DATA_DIR, so an operator who
# wants home and config on separate volumes can say so.
export HOME="${SIGRUN_HOME:-/data/home}"

# A missing or unwritable HOME is otherwise a confusing mkdir stack trace
# from sigrun's own store-root bootstrap; fail loud and actionable here.
fail_home() {
	echo "sigrun-entrypoint: HOME=$HOME is not a writable directory" >&2
	echo "  (set SIGRUN_HOME to one, e.g. a directory on the data volume)" >&2
	exit 1
}

if [ "$(id -u)" -eq 0 ]; then
	# /cache/npm too: it is pre-created 1000:1000 in the image, so a
	# shifted SG_UID root start could not write its npm cache without
	# this (still mount-point-shaped — never recursive).
	chown "$SG_UID:$SG_GID" /data /cache /cache/npm
	# HOME is not in the image (it lives on the mounted data volume), so
	# create it and hand it to the drop target. Checked as the drop
	# target would see it: root's own -w says nothing about SG_UID.
	mkdir -p "$HOME" 2>/dev/null || fail_home
	chown "$SG_UID:$SG_GID" "$HOME"
	# --clear-groups, not --init-groups: the latter resolves the target
	# uid in /etc/passwd and fails outright for any uid the image has no
	# entry for ("setpriv: uid N not found, --init-groups requires an
	# user that can be found on the system") — exactly the rootless case
	# this trampoline exists to serve. The primary gid still comes from
	# --regid.
	exec setpriv --reuid="$SG_UID" --regid="$SG_GID" --clear-groups "$@"
fi

# Non-root: the runtime that chose the uid owns the volume-permission
# story. Still ensure HOME — a clear failure here beats a confusing stack
# trace later.
mkdir -p "$HOME" 2>/dev/null && [ -w "$HOME" ] || fail_home
exec "$@"
