#!/bin/sh
# Conservé pour les anciennes procédures. L'installation passe par run-infractl.sh.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../../.." && pwd)
exec bash "$ROOT/run-infractl.sh" --mode agent --install "$@"
