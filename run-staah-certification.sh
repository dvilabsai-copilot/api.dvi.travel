#!/usr/bin/env bash
# Runs the local STAAH certification evidence generator.
set -euo pipefail
cd "$(dirname "$0")"
npm run cert:staah