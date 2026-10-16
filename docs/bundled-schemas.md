# Bundled schemas

Buffalo decodes each format with the format's own official schema, bundled in the repo and
shown to users in the **Schemas** menu. They are not hand-translated.

| File                                     | Format              | Upstream                                                                                                            | Pinned release | License                       |
| ---------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------- |
| `src/lib/core/input/onnx/onnx.proto`     | ONNX (protobuf)     | [onnx/onnx](https://github.com/onnx/onnx) `onnx/onnx.proto`                                                         | `v1.23.2`      | Apache-2.0                    |
| `src/lib/core/input/tflite/schema.fbs`   | TensorFlow Lite     | [tensorflow/tensorflow](https://github.com/tensorflow/tensorflow) `tensorflow/compiler/mlir/lite/schema/schema.fbs` | `v2.21.0`      | Apache-2.0                    |
| `src/lib/core/input/pte/program.fbs`     | ExecuTorch (`.pte`) | [pytorch/executorch](https://github.com/pytorch/executorch) `schema/program.fbs`                                    | `v1.5.1`       | see upstream `LICENSE` (Meta) |
| `src/lib/core/input/pte/scalar_type.fbs` | ExecuTorch (`.pte`) | same, `schema/scalar_type.fbs` (included by `program.fbs`)                                                          | `v1.5.1`       | see upstream `LICENSE` (Meta) |

Each file keeps its upstream license header unchanged.

## How they are used

- **Decoding.** ONNX is parsed at runtime by protobufjs (`core/input/onnx/index.ts`). The
  FlatBuffers schemas are parsed by Buffalo's own `.fbs` parser (`core/input/flatbuffers/schema.ts`)
  and drive a generic reader (`reader.ts`). Both run in the worker.
- **Viewing.** Each input format lists its files in `baseSchemas`; `baseSchemas()` in
  `core/formats.ts` feeds the Schemas menu. User-supplied `.fbs` files appear there too.
- **Tests.** `src/lib/core/formats.test.ts` parses every bundled schema, and the format tests decode
  generated files built against them. A schema update that breaks the parser or reader fails there.

## Updating

```sh
# edit the tags at the top of the script, or override them for one run:
ONNX_TAG=v1.24.0 pnpm schemas:update
pnpm test
```

`scripts/update-schemas.sh` re-downloads all four files from the tags above. Running it unchanged
reproduces the committed files byte for byte. After an update:

1. Run `pnpm test`. The ONNX, TFLite and ExecuTorch tests decode generated files.
2. The test builders `core/input/tflite/testing.ts` and `core/input/pte/testing.ts` hard-code vtable
   **slot numbers** (field order in the schema). If upstream added a field in the middle of a table
   (rare: FlatBuffers schemas only append), update the slots there.
3. Update the pinned versions in the table above, in the script, and in the comments of
   `core/input/tflite/index.ts` and `core/input/pte/index.ts`.
4. For ONNX, new `TensorProto.DataType` values may need entries in `ONNX_DTYPES`
   (`core/input/onnx/tensor.ts`). For TFLite and ExecuTorch, new tensor types go in
   `tflite/tensors.ts` / `pte/tensors.ts`.
