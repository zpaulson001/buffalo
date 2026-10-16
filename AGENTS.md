# Buffalo: agent guide

Buffalo is a client-side, no-backend SvelteKit (SPA) app. The user drops a binary model file and
views it as JSON, protobuf text, FlatBuffers text (FBT) or hex. All parsing happens in a Web Worker.

Input formats: `.onnx` (protobuf), `.tflite` (FlatBuffers), `.pte` (ExecuTorch, FlatBuffers), and any
other FlatBuffers file when the user drops its `.fbs` schema alongside it.

## Commands

Needs Node >= 22.13 and **pnpm 12** (pinned in `package.json` `packageManager`; use the pinned
version, not an older global one).

```sh
pnpm install
pnpm dev              # http://localhost:5173
pnpm check            # svelte-check (types)
pnpm lint             # prettier --check + eslint
pnpm test             # vitest, ~5 s, no browser needed
pnpm build            # static site in build/ (adapter-static, SPA fallback)
pnpm format           # prettier --write
pnpm samples          # generate small sample files in samples/ (gitignored)
pnpm samples:big      # also generate large ones that trigger the size guard
pnpm schemas:update   # re-fetch bundled schemas from pinned upstream tags
```

Before finishing any change run `pnpm check && pnpm lint && pnpm test`; run `pnpm build` if you
touched config, routes or anything imported by the worker.

## Hard constraints (decided by the owner)

- **Svelte 5 runes** (`$state`, `$derived`, `$effect`, `$props`). No Svelte 4 syntax. Runes mode is forced in `vite.config.ts`.
- **`src/lib/core/` and `src/lib/worker/` import nothing from Svelte** and are unit-testable in Node.
- **CodeMirror 6 used directly** (no wrapper library), read-only, with highlighting and folding.
- **Keep dependencies minimal.** Runtime: `protobufjs` and the `@codemirror/*` packages. Dev-only extras
  are justified below; ask before adding more.
- **No backend.** Nothing leaves the browser.
- **All parsing and serialising runs in the worker**; the UI thread only appends text to the editor.
- **Never build one huge string.** Output is generated as small strings, batched into ~1 MB chunks and
  streamed. Don't regress this.
- 64-bit integers must never lose precision: JSON prints them as strings; text formats print bare digits.

## Architecture

```
src/
  routes/+page.svelte          page: header, format buttons, Schemas menu, theme, banners
  lib/
    ui/                        Svelte-aware code
      session.svelte.ts        Session: all UI state + actions (testable via an injected worker factory)
      OutputEditor.svelte      CodeMirror host: sink.reset(language)/append(text), live theme swap
      SchemaMenu, SizeGuardDialog
      languages.ts             editor languages (json, prototext/fbt, proto, fbs); folding via foldIndex.ts
      editorTheme.ts, theme.svelte.ts
    worker/
      protocol.ts              ToWorker / FromWorker message unions
      engine.ts                all worker logic, no `self` dependency (testable)
      parse.worker.ts          3-line entry: new Engine(postMessage)
      client.ts                typed Worker wrapper
    core/                      framework-agnostic
      model.ts                 neutral Node tree (see below)
      formats.ts               registries: inputFormats, outputFormats; resolveInputFormat; baseSchemas()
      types.ts                 InputFormat / OutputFormat interfaces
      config.ts                all tunables (size limit, truncation, chunk size, ...)
      input/                   onnx/, tflite/, pte/ (each: index.ts + tensors), flatbuffers/ (.fbs parser + reader)
      output/                  json.ts (also the shared JSON-like layout), fbt.ts, prototext.ts, hex.ts
      estimate.ts numfmt.ts rawarray.ts chunker.ts base64.ts
scripts/                       make-samples.ts, update-schemas.sh
docs/bundled-schemas.md        where each bundled schema came from and how to update it
```

### Data flow

1. `Session.openFiles` routes dropped files: `.fbs` files become the user schema, anything else is
   the data file. `Session.open` posts `open {file, schema?}`.
2. `Engine.open` reads the file (streamed, with progress), picks a format with `resolveInputFormat`
   (a user schema wins over the extension) and calls `format.decode(bytes)` → a `Node` tree. The
   decoded tree stays in the worker.
3. `Session.render` posts `render {runId, format, truncateTo, force}`. The engine estimates the output
   size; above `MAX_OUTPUT_BYTES` (200 MB) it replies `needsConfirm` instead and the UI asks.
4. Otherwise it runs `outputFormat.serialize()` (a generator of strings) through `chunked()` and posts
   `chunk` messages. At most `MAX_INFLIGHT_CHUNKS` may be unacknowledged; the UI acks after
   `sink.append` has applied a chunk. A new `render`/`open`/`cancel` supersedes the run (`runId`).
5. Switching output format re-runs only step 3 on the retained tree.

### The Node tree (`core/model.ts`)

`scalar` (with a `dtype`), `str`, `bytes`, `enum`, `list`, `obj` (ordered entries, optional `note` for
synthetic objects), and lazy `array` (`dtype`, `length`, `get(i)`). Tensor data is an `array` view over
the raw bytes so a 100M-element tensor never becomes a JS array. Unset/absent fields are omitted.
Input formats produce it; output formats walk it. Hex works from the original file bytes instead.

## Recipes

**Add an output format:** write `core/output/<name>.ts` exporting an `OutputFormat`
(`id`, `label`, `language`, `truncate`, `estimate`, `serialize`), add it to `outputFormats` in
`core/formats.ts`, and if it needs highlighting add a case in `ui/languages.ts`. For JSON-shaped text,
reuse `makeJsonLikeFormat` with a `JsonStyle` (see `fbt.ts`).

**Add a FlatBuffers input format:** bundle the `.fbs` (add it to `scripts/update-schemas.sh` and
`docs/bundled-schemas.md`), then `createFlatbuffersFormat(sources, { id, label, extensions, baseSchemas,
postProcess })` as in `tflite/index.ts` / `pte/index.ts`. `postProcess(root, bytes)` is where tensor
data gets decoded; use `core/input/nodeutil.ts` helpers and `core/rawarray.ts`.

**Add a protobuf input format:** see `onnx/index.ts` (protobufjs reflection + field hooks in
`input/protobuf.ts`).

Every input format should expose `baseSchemas` so the Schemas menu can show its schema.

## Testing conventions

- Tests sit next to the code (`*.test.ts`). `vitest` runs in Node (`environment: 'node'`).
- FlatBuffers tests build binaries with the **official `flatbuffers` JS Builder** (a dev dependency) so
  the reader is checked against an independent writer. The builders are `tflite/testing.ts` and
  `pte/testing.ts`; they hard-code vtable slot numbers from the bundled schemas.
- `session.test.ts` drives `Session` with a fake worker; `engine.test.ts` drives `Engine` with a fake
  `post`. There are no component tests (no jsdom); verify UI by running the app.
- `testing.ts` files and `scripts/*.ts` may only use **erasable TypeScript** (no enums, namespaces or
  parameter properties) because `pnpm samples` runs them with Node's built-in type stripping.

## Trying the app / verifying UI changes

`pnpm samples`, then `pnpm dev`, then drop files from `samples/` onto the page. From an automated
browser, simulate a drop:

```js
const dt = new DataTransfer();
dt.items.add(new File([await (await fetch('/some-file')).arrayBuffer()], 'model.tflite'));
document
	.querySelector('[role=application]')
	.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
```

Fold gutter markers respond to `mousedown` + `click` events on `.cm-foldGutter span[title]`.

## Gotchas

- **`cookie` dev dependency.** SvelteKit's prerender step loads its server bundle from
  `.svelte-kit/output` and imports `cookie`. If an old `cookie` exists in an _ancestor_ `node_modules`
  (e.g. `~/node_modules/cookie`), Node picks it up instead of the project's and the build fails with
  "does not provide an export named 'parseCookie'". Declaring `cookie` directly pins the right copy.
  A clean machine doesn't need it; it is harmless there.
- **pnpm version.** Older pnpm (10.x) can't use a node_modules created by 11/12 (`ERR_PNPM_UNEXPECTED_STORE`).
  If `pnpm -v` is not 12.x, run `pnpm self-update` or use `corepack`; a stale global pnpm under nvm's
  Node can shadow Homebrew's.
- **pnpm blocks dependency install scripts** unless allowed in `pnpm-workspace.yaml` (`allowBuilds`).
  `esbuild` and `workerd` (Cloudflare's runtime, via `wrangler`) are allowed. A new dependency with an
  install script fails `pnpm install` with `ERR_PNPM_IGNORED_BUILDS` until it's added there.
- **Cloudflare deploy.** `wrangler.jsonc` serves `build/` as an SPA; `wrangler` is a dev dependency so
  the deploy step doesn't auto-install it (that auto-install is what trips the previous gotcha). Check
  a deploy locally with `pnpm exec wrangler deploy --dry-run` after `pnpm build`.
- **Adapter config lives in `vite.config.ts`** (SvelteKit 3 style), there is no `svelte.config.js`.
- **Theme.** Dark mode is class-based (`@custom-variant dark` in `routes/layout.css`). A tiny script in
  `app.html` applies the saved theme before paint; keep it in sync with `ui/theme.svelte.ts`.
- **Prettier** uses tabs; run `pnpm format` rather than hand-aligning.

## Known limitations

- `[ubyte]` FlatBuffers vectors print as base64 `bytes` (they are usually blobs), not number lists in JSON.
- Quantised (`QINT8`, …) tensors show raw integers, not dequantised values; int4/fp8/complex and
  string tensors stay base64. ExecuTorch delegate blobs and mutable/named data aren't decoded.
- ONNX tensors with external data show metadata only.
- A single very large `bytes` field becomes one long base64 line, which CodeMirror handles poorly.
- The `.fbs` parser skips `rpc_service`, and doesn't support `nested_flatbuffer` or size-prefixed buffers.
  A custom schema needs a `root_type`.
- Fold detection for prototext/FBT/schema views is line-based: a `{` followed by a trailing comment
  on the same line won't fold.
- The main bundle includes protobufjs and the schema texts because the UI imports the format registry.
- Output over ~200 MB can still use several hundred MB of tab memory; that's why the size guard exists.
