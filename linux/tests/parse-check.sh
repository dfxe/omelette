#!/bin/sh
# Parse every extension module.
#
# Most of the extension imports St/Clutter/PanelMenu and cannot be loaded
# outside gnome-shell, so extension.js, prefs.js, colorPicker.js and friends get
# no unit-test coverage at all. A syntax check is cheap and catches the mistake
# that actually costs a shell restart to discover.
#
# Uses node purely as an ES-module parser; it is never used to *run* anything.
# Skips (rather than fails) when node is unavailable, since the project has no
# other node dependency.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ext="$here/../omelette@dfxe.github.io"

if ! command -v node >/dev/null 2>&1; then
    echo "  node not found — skipping parse check"
    exit 0
fi

tmp=$(mktemp -d "${TMPDIR:-/tmp}/omelette-parse.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM

status=0
count=0
# The editor is a separate GTK4 program shipped inside the extension directory,
# so it needs checking too — and its files are named for their role, which means
# editor/render.js would collide with a top-level render.js under basename. The
# path is flattened instead: editor/render.js becomes editor-render.mjs.
for f in "$ext"/*.js "$ext"/editor/*.js; do
    [ -e "$f" ] || continue
    rel=${f#"$ext"/}
    base=$(printf '%s' "${rel%.js}" | tr / -)
    # node infers module type from the extension; .mjs forces ESM.
    cp "$f" "$tmp/$base.mjs"
    if ! node --check "$tmp/$base.mjs"; then
        echo "  parse error in $base.js"
        status=1
    fi
    count=$((count + 1))
done

[ "$status" -eq 0 ] && echo "  $count modules parse cleanly"
exit "$status"
