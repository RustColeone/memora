# Notices

Memora is free software: you can redistribute it and/or modify it under the
terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version. See [LICENSE](LICENSE).

Copyright (C) 2026 The Memora authors.

Memora is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
A PARTICULAR PURPOSE.

The parts below are not covered by the AGPL. They keep their own licenses.

## Artwork

| What | Where | License |
|---|---|---|
| Deepseek-Chan, GPT-Chan and Claude-Chan illustrations by ZipZipPipe (Deepseek-Chan original character by 上善无形) | `src/static/credits-images/` | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/): non-commercial only. See [the folder's NOTICE](src/static/credits-images/NOTICE.md) |

## Bundled libraries and models

| What | Where | License |
|---|---|---|
| PDF.js (Mozilla) | `src/static/vendor/pdf.min.mjs`, `pdf.worker.min.mjs` | Apache-2.0 |
| jsPDF | `src/static/vendor/jspdf.umd.min.js` | MIT |
| JSZip | `src/static/vendor/jszip.min.js` | MIT or GPLv3 ([license](src/static/vendor/jszip.LICENSE.md)) |
| sql.js | `src/static/vendor/sql-wasm.js`, `sql-wasm.wasm` | MIT |
| gifuct-js | `src/static/vendor/gifuct.js` | MIT ([license](src/static/vendor/gifuct.LICENSE)) |
| gifenc | `src/static/vendor/gifenc.js` | MIT |
| Anthropic TypeScript SDK | `src/static/vendor/anthropic-sdk.js` | MIT ([license](src/static/vendor/anthropic-sdk.LICENSE)) |
| MediaPipe Image Embedder, MobileNet-V3 small | `android/app/src/main/assets/models/image_embedder_v1.tflite` | Apache-2.0 ([notice](android/app/src/main/assets/models/NOTICE.md)) |

Dependencies installed by npm, pip or Gradle at build time keep their own licenses.

## Icons

The notebook app icon (`src/static/icons/notebook.svg` and the PNGs made from
it) and `src/note-notepad-svgrepo-com.svg` come from [SVG Repo](https://www.svgrepo.com/)
under the license shown on their SVG Repo pages.

## Name

The license covers the code. It does not grant use of the Memora name for a
changed version (AGPL section 7(e)): if you publish your own build, give it a
different name.
