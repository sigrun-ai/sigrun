#!/bin/sh
# sigrun chart settings seeder (image workflow spec §4, ownership
# semantics). Runs as the seed initContainer under the pod security
# context — it NEVER chowns anything (volume permissions are the
# runtime's story, entrypoint's job on root starts).
#
#   seed-settings.sh CONFIG_DIR FLEET_JSON SETTINGS_JSON EXT_SETTINGS_JSON
#
# The chart renders argv 2-4 via toJson — always present, `[]`/`{}` when
# empty (never omitted). Two ownership regimes, deliberately different:
#
# - settings.json is RE-ASSERTED every boot (GitOps: the values file is
#   the source of truth for chart-owned keys). SETTINGS_JSON merges
#   SHALLOW — foreign keys (admin-API/operator writes) survive, chart
#   keys are overwritten WHOLESALE, so a sub-key dropped from values
#   vanishes from the file on the next boot (a deep merge would keep it
#   alive as zombie config). `extensions` is set to FLEET_JSON
#   unconditionally — an empty fleet writes `extensions: []`, which is
#   how removing an extension from values removes it from the file.
# - settings/<slug>.json is SEED-ONCE: written only when absent. After
#   first boot the EXTENSION owns the file (the server-mediated
#   ExtensionSettingsStore writes there at runtime); re-asserting here
#   would clobber those self-writes. Changing a seeded value = delete
#   the file or use the extension's own surface.
#
# Fail-loud posture: malformed or wrong-shaped argv JSON, an existing
# but unparseable settings.json, or a non-slug key all exit nonzero
# BEFORE any write — a CrashLooping initContainer pointing at the exact
# argument beats a silently half-seeded config volume.
#
# Writes are atomic-ish: tmp file + mv in the same directory (rename is
# same-filesystem atomic), matching the stores' writeFileAtomic shape.
set -eu

if [ "$#" -ne 4 ]; then
	echo "usage: seed-settings.sh CONFIG_DIR FLEET_JSON SETTINGS_JSON EXT_SETTINGS_JSON" >&2
	exit 2
fi

CONFIG_DIR=$1
FLEET_JSON=$2
SETTINGS_JSON=$3
EXT_SETTINGS_JSON=$4

# --- argv validation (all args checked, all problems reported in one
# exit — a chart render bug shows every bad argument on the first pod
# restart, not one per CrashLoop). jq -e doubles as the parser: a parse
# failure exits nonzero exactly like a type mismatch, so one helper
# covers both "unparseable" and "wrong shape".

json_is_array() { printf '%s' "$1" | jq -e 'type == "array"' >/dev/null 2>&1; }
json_is_object() { printf '%s' "$1" | jq -e 'type == "object"' >/dev/null 2>&1; }

errors=""
if ! json_is_array "$FLEET_JSON"; then
	errors="$errors${errors:+;
}seed-settings: invalid FLEET_JSON: expected a JSON array"
fi
if ! json_is_object "$SETTINGS_JSON"; then
	errors="$errors${errors:+;
}seed-settings: invalid SETTINGS_JSON: expected a JSON object"
fi
if ! json_is_object "$EXT_SETTINGS_JSON"; then
	errors="$errors${errors:+;
}seed-settings: invalid EXT_SETTINGS_JSON: expected a JSON object (slug -> settings object)"
else
	# Values must be objects (each seeds one JSON settings file) and keys
	# must be slugs — the slugifyName alphabet. The key check is also the
	# path-traversal guard: `../x` and `/abs` both fail it, so a seeded
	# file can only ever land inside settings/ under its own name.
	non_objects=$(printf '%s' "$EXT_SETTINGS_JSON" |
		jq -r 'to_entries | map(select(.value | type != "object") | .key) | join(", ")')
	if [ -n "$non_objects" ]; then
		errors="$errors${errors:+;
}seed-settings: invalid EXT_SETTINGS_JSON: settings for slug(s) \"$non_objects\" are not JSON objects"
	fi
	bad_slugs=$(printf '%s' "$EXT_SETTINGS_JSON" |
		jq -r 'keys[] | select(test("^[a-z0-9_-]+$") | not)')
	if [ -n "$bad_slugs" ]; then
		errors="$errors${errors:+;
}seed-settings: invalid EXT_SETTINGS_JSON key(s): \"$bad_slugs\" — keys are extension slugs (lowercase a-z, 0-9, -, _)"
	fi
fi
if [ -n "$errors" ]; then
	echo "$errors" >&2
	exit 1
fi

SETTINGS_FILE="$CONFIG_DIR/settings.json"
mkdir -p "$CONFIG_DIR" "$CONFIG_DIR/settings"

# --- settings.json re-assert. An existing file must be a parseable
# JSON object (or JSON null): anything else is corruption the operator
# must see, never something a re-assert silently resets to {}.
existing='null'
if [ -e "$SETTINGS_FILE" ]; then
	if ! jq -e '(type == "object") or (type == "null")' "$SETTINGS_FILE" >/dev/null 2>&1; then
		echo "seed-settings: $SETTINGS_FILE exists but is not a parseable JSON object — refusing to overwrite; fix or remove the file" >&2
		exit 1
	fi
	existing=$(jq -c '.' "$SETTINGS_FILE")
fi

# Slurp [existing, SETTINGS_JSON], shallow-merge, then set `extensions`
# LAST so the fleet array wins even if SETTINGS_JSON carried a stray
# extensions key. `.[0] // {}`: a null (absent-file) existing starts
# from empty.
merged=$(printf '%s\n%s\n' "$existing" "$SETTINGS_JSON" |
	jq -s --argjson fleet "$FLEET_JSON" \
		'((.[0] // {}) + .[1] + { extensions: $fleet })')

tmp="${SETTINGS_FILE}.tmp.$$"
printf '%s\n' "$merged" > "$tmp"
mv -f "$tmp" "$SETTINGS_FILE"

# --- seed-once per-slug settings. Word-splitting the keys is safe:
# they were validated against the slug alphabet above, so no whitespace
# survives in a key that reached this loop.
for slug in $(printf '%s' "$EXT_SETTINGS_JSON" | jq -r 'keys[]'); do
	target="$CONFIG_DIR/settings/$slug.json"
	if [ -e "$target" ]; then
		continue
	fi
	tmp="${target}.tmp.$$"
	printf '%s\n' "$(printf '%s' "$EXT_SETTINGS_JSON" | jq --arg slug "$slug" '.[$slug]')" > "$tmp"
	mv -f "$tmp" "$target"
done
