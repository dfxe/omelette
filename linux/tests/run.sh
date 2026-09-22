#!/bin/sh
# Run the extension's unit tests.
#
#   linux/tests/run.sh
#
# XDG_DATA_HOME is redirected at a throwaway directory before gjs starts —
# GLib caches g_get_user_data_dir() on first use, so this cannot be done from
# inside the test process. vaultStore.test.js writes real files and refuses to
# run without the sandbox flag.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sandbox=$(mktemp -d "${TMPDIR:-/tmp}/omelette-tests.XXXXXX")
trap 'rm -rf "$sandbox"' EXIT INT TERM

if command -v node >/dev/null 2>&1; then
    node --test "$here/capture.test.mjs"
fi

XDG_DATA_HOME="$sandbox" \
OMELETTE_TEST_SANDBOX=1 \
exec gjs -m "$here/run.js"
