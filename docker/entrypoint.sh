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
set -eu

# The uid/gid a root start drops to. Defaults match the image's USER;
# env-overridable so an operator can shift sigrun onto an existing site
# uid without an image rebuild.
SG_UID="${SG_UID:-1000}"
SG_GID="${SG_GID:-1000}"

if [ "$(id -u)" -eq 0 ]; then
	# /cache/npm too: it is pre-created 1000:1000 in the image, so a
	# shifted SG_UID root start could not write its npm cache without
	# this (still mount-point-shaped — never recursive).
	chown "$SG_UID:$SG_GID" /data /cache /cache/npm
	# node's home dir: needed writable when the drop targets a uid other
	# than 1000 (npm config, tool caches land under $HOME). Guarded — a
	# missing or read-only dir must not block the drop.
	if [ -d /home/node ] && [ -w /home/node ]; then
		chown "$SG_UID:$SG_GID" /home/node
	fi
	exec setpriv --reuid="$SG_UID" --regid="$SG_GID" --init-groups "$@"
fi

exec "$@"
