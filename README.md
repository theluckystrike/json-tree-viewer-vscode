# JSON Viewer & JSON Tree

<a href="https://marketplace.visualstudio.com/items?itemName=zovo.zovo-json-tree-viewer"><img src="https://img.shields.io/visual-studio-marketplace/i/zovo.zovo-json-tree-viewer?label=VS%20Code%20installs" alt="VS Code installs"></a>
<a href="https://marketplace.visualstudio.com/items?itemName=zovo.zovo-json-tree-viewer"><img src="https://img.shields.io/visual-studio-marketplace/v/zovo.zovo-json-tree-viewer?label=version" alt="Version"></a>
<img src="https://img.shields.io/badge/offline-no%20telemetry-2ea44f" alt="Offline, no telemetry">

See any JSON file as a fast, searchable tree, copy the path of any value in one click, and turn arrays of objects into a sortable table.

<img src="images/config-search.png" alt="A nested service config as a JSON tree expanded to level 3, with the four host keys found by search highlighted and the selected path $.server.port in the bottom bar" width="100%">

*A real VS Code window (1.142, Dark Modern) with the packaged extension installed. The file comes from `scripts/make-samples.js`.*

- It stays quick on big files. A worker thread parses the file, and the view only draws the rows on screen. In the test suite a 30 MB array with 350,000 objects shows its first rows in about 0.6 s, and a search of the whole file takes under 0.1 s.
- It answers "where is this value?" Search keys and values with next and previous. Click any node to see its JSONPath (`$.items[3].id`), then copy it, the JS path (`data.items[3].id`) or the value.
- It opens what other viewers leave as text. Arrays of objects become a table with sortable columns. Strings that hold escaped JSON, such as log payloads and HAR response bodies, open as a nested tree. Comments, trailing commas and JSON5 are accepted.

## Quick start

1. Open a `.json`, `.jsonc`, `.json5`, `.geojson`, `.har`, `.ipynb` or `.webmanifest` file and click the tree icon at the top right of the editor.
2. Click nodes to expand them, or use the 1, 2, 3 and All buttons. Type in Search and press Enter.

The normal text editor stays the default, so editing works as before. To view JSON that is not saved in a file, select it (or copy it) and run "JSON Viewer: Open Selection or Clipboard in JSON Viewer".

## What you can do

| | |
|---|---|
| <img src="images/users-table.png" alt="50,000 user records shown as a table sorted by score from high to low, one cell selected with its path $[5879].name" width="100%"> | <img src="images/escaped-json.png" alt="An event payload stored as an escaped JSON string opened as a nested tree, with the JS path JSON.parse(data.events[0].payload).user.name" width="100%"> |
| Table of an array of objects, sorted by score | Escaped JSON string opened as a tree |
| <img src="images/broken-json.png" alt="A file with a missing comma shows the message Expected comma at line 5, column 15 and the three lines around it" width="100%"> | <img src="images/geojson-light.png" alt="GeoJSON weather stations in the light theme as a tree at level 2" width="100%"> |
| Clear error with line and column | Follows your theme, light or dark |

### Tree

Each row shows the key, a type badge (obj, arr, str, num, bool, null) and the child count. Closed objects show a short preview such as `{host: "0.0.0.0", port: 8443, tls: {…}}`. Expand to level 1, 2, 3 or all, or collapse to the root. Arrow keys move, Right opens, Left closes or goes to the parent, Enter toggles.

### Search

Search covers every key and value in the file, not only the open rows, and ignores case. Enter or ↓ goes to the next match, Shift+Enter or ↑ goes back. The tree opens the parents of each match and highlights the matching rows.

### Copy

The bottom bar shows the selected node's JSONPath and type. Copy JSONPath, Copy JS path and Copy value put it on the clipboard. Keys that are not plain names are quoted, as in `$['odd keys']` and `data["odd keys"]`. Strings are copied as plain text and everything else as formatted JSON.

### Table

Arrays of objects get a Table chip, and a root array opens from the Table tab. There is one column per key, with its type. Click a header to sort it up, again to sort it down, and a third time to clear the sort. Missing values sort last. Click a cell to get its path and copy its value.

### Escaped JSON

When a string holds a JSON object or array, the row gets a JSON string chip. Click it to read the string as a tree. Paths inside it come out as `JSON.parse(data.events[0].payload).user.id`.

### Formats

`.json`, `.jsonc` (comments and trailing commas), `.json5`, `.geojson`, `.har`, `.ipynb` and `.webmanifest` open from the editor title or the Explorer menu. Any other file opens through the command "JSON Viewer: Open in JSON Viewer". UTF-8 and UTF-16 files with a byte order mark both work.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `jsonTreeViewer.maxFileMB` | 200 | Largest file the viewer reads. Bigger files show a message and are not read. Parsing takes several times the file size in memory. |
| `jsonTreeViewer.askForRating` | true | Ask one time for a Marketplace rating after a few days of use. |

## Privacy

The extension works offline. It makes no network calls and has no telemetry. The viewer page has a strict Content Security Policy with no remote sources, and all file text is shown as text, never as HTML. Files are opened read-only.

## Limits

- Files over 200 MB (the setting goes up to 1 GB) are not opened. Use the text editor or a streaming tool such as jq for those.
- Expand all stops at 1,000,000 visible rows, and search stops at 10,000 matches. Both show a note when that happens.
- Numbers beyond 2^53 lose precision, as in JavaScript's own JSON.parse.
- The table shows the first 200 keys as columns.
- JSONPath for nodes inside an escaped JSON string just continues the outer path. Use the JS path for an exact address.

## More viewers by Zovo

- [Context Drift](https://marketplace.visualstudio.com/items?itemName=zovo.context-drift) finds stale facts in AGENTS.md, CLAUDE.md and other agent rule files.
- [PDF Viewer & Reader with Dark Mode](https://marketplace.visualstudio.com/items?itemName=zovo.pdf-viewer-dark) reads PDFs with a real dark mode, search, an outline and thumbnails.
- [CSV, Excel & Parquet Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.table-viewer-vscode) opens Parquet, Excel and CSV files as a sortable, filterable table.
- [DOCX Viewer & Word Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.docx-viewer-vscode) previews Word files with dark mode, an outline and search.
- [HDF5 & NetCDF Explorer](https://marketplace.visualstudio.com/items?itemName=zovo.hdf5-netcdf-explorer) browses groups, variables and attributes in scientific data files.
- [PPTX Viewer for PowerPoint](https://marketplace.visualstudio.com/items?itemName=zovo.pptx-slide-viewer) shows PowerPoint slides, thumbnails and speaker notes.
- [Skill Shelf](https://marketplace.visualstudio.com/items?itemName=zovo.skill-shelf) lists, checks and toggles the Agent Skills that Claude Code, Codex and Cursor load.
- [Tensor Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.tensor-viewer) shows NPY, NPZ, Safetensors and GGUF tensors with stats and heatmaps.

## License

MIT. JSON5 parsing uses the json5 package (MIT), listed in THIRD-PARTY-NOTICES.txt.
