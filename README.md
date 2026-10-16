# Buffalo

Drop a binary model file in your browser and read it as **JSON**, **protobuf text**, **FlatBuffers
text** or **hex**. Everything runs client-side in a Web Worker, so nothing leaves your machine.

| Input                            | How it is read                                                      |
| -------------------------------- | ------------------------------------------------------------------- |
| `.onnx` (protobuf)               | bundled `onnx.proto`                                                |
| `.tflite` (FlatBuffers)          | bundled TensorFlow Lite `schema.fbs`                                |
| `.pte` (ExecuTorch, FlatBuffers) | bundled `program.fbs` + `scalar_type.fbs`, including segment data   |
| any other FlatBuffers file       | drop its `.fbs` schema (and any it includes) together with the file |

## Features

- Tensor data is shown as real values, decoded from raw bytes by data type (float32/16, bfloat16,
  int8–64, bool, …). 64-bit integers stay exact (strings in JSON).
- Large files are handled safely: output is streamed to the editor in chunks, with progress. If the
  estimated output exceeds 200 MB you're offered to truncate each tensor to its first N values
  (marked `... N more values`) instead.
- Read-only CodeMirror 6 editor with syntax highlighting, folding and search.
- **Schemas** menu shows the bundled schemas (and any you loaded) as source.
- Light / dark / system theme.

## Quick start

Requires Node >= 22.13 and pnpm 12.

```sh
pnpm install
pnpm samples      # small sample files in ./samples (gitignored)
pnpm dev          # http://localhost:5173, then drop a file from ./samples
```

To try a custom schema, drop `samples/tiny.fbs` together with `samples/data.bin`.

## Scripts

| Command               | What it does                                                        |
| --------------------- | ------------------------------------------------------------------- |
| `pnpm dev`            | dev server                                                          |
| `pnpm build`          | static site in `build/` (SPA, host it anywhere)                     |
| `pnpm preview`        | serve the production build                                          |
| `pnpm check`          | type-check (svelte-check)                                           |
| `pnpm lint`           | prettier + eslint                                                   |
| `pnpm test`           | unit tests (vitest)                                                 |
| `pnpm samples[:big]`  | generate sample files; `:big` adds ones that trigger the size guard |
| `pnpm schemas:update` | re-fetch the bundled schemas from their pinned releases             |

## Deploying (Cloudflare)

The build is a static site, so any static host works. For Cloudflare, `wrangler.jsonc` serves `build/`
as a single-page app. Use these settings in the Cloudflare dashboard:

| Setting        | Value                 |
| -------------- | --------------------- |
| Build command  | `pnpm build`          |
| Deploy command | `npx wrangler deploy` |

Or deploy from your machine (after `npx wrangler login`): `pnpm deploy`.

## Configuration

Limits you may want to change are in [`src/lib/core/config.ts`](src/lib/core/config.ts): the size
guard (`MAX_OUTPUT_BYTES`), default truncation (`TRUNCATE_TO`, `HEX_TRUNCATE_BYTES`), chunk size and
values per line.

## More

- [`AGENTS.md`](AGENTS.md): architecture, data flow, how to add formats, testing conventions,
  gotchas and known limitations (written for contributors and coding agents).
- [`docs/bundled-schemas.md`](docs/bundled-schemas.md): where each bundled schema comes from and how to update it.
