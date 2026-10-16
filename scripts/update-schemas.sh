#!/usr/bin/env bash
# Re-downloads the schema files bundled with Buffalo from their upstream release tags.
# To move to a newer release, change the tag (here or via the environment) and run:
#
#   ONNX_TAG=v1.24.0 scripts/update-schemas.sh
#
# Then run `pnpm test`: it parses every bundled schema and decodes generated files with it.
# See docs/bundled-schemas.md for what each file is and how it's used.
set -euo pipefail

ONNX_TAG="${ONNX_TAG:-v1.23.2}"
TENSORFLOW_TAG="${TENSORFLOW_TAG:-v2.21.0}"
EXECUTORCH_TAG="${EXECUTORCH_TAG:-v1.5.1}"

root="$(cd "$(dirname "$0")/.." && pwd)"
input="$root/src/lib/core/input"

fetch() { # <url> <destination>
  echo "  $2  <-  $1"
  curl -fsSL "$1" -o "$2"
}

echo "ONNX $ONNX_TAG"
fetch "https://raw.githubusercontent.com/onnx/onnx/$ONNX_TAG/onnx/onnx.proto" \
  "$input/onnx/onnx.proto"

echo "TensorFlow $TENSORFLOW_TAG"
fetch "https://raw.githubusercontent.com/tensorflow/tensorflow/$TENSORFLOW_TAG/tensorflow/compiler/mlir/lite/schema/schema.fbs" \
  "$input/tflite/schema.fbs"

echo "ExecuTorch $EXECUTORCH_TAG"
for f in program.fbs scalar_type.fbs; do
  fetch "https://raw.githubusercontent.com/pytorch/executorch/$EXECUTORCH_TAG/schema/$f" \
    "$input/pte/$f"
done
