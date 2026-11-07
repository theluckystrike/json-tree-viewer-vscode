# Changelog

## 0.2.0 (2026-11-07)

- Exact big numbers: 64-bit IDs and other numbers too long for JavaScript show digit for digit instead of rounded. Copy value, search and the table use the exact digits, and a note says how many were kept.
- Go to line: a button in the bottom bar (or the G key) opens the text editor beside the viewer with the cursor on the selected node or table cell.
- Reload on change: the tree reads the file again when it changes on disk or is saved, and keeps open nodes, the selection, the scroll position, the search and the table. Broken JSON in the middle of a write keeps the last good version on screen. Setting: `jsonTreeViewer.autoReload`.

## 0.1.5 (2026-11-07)

- "More free viewers" now starts with the Zovo extensions most related to this one. Picking one opens its Marketplace page, where you choose to install it.
- The README has a "Support Zovo" section with GitHub Sponsors and the developer's GitHub profile, and "More tools by Zovo" lists related extensions.

## 0.1.4 (2026-11-07)

- The footer under the viewer has a "Rate" link next to Sponsor and More free viewers. It opens the review page of this extension on the Marketplace. Nothing pops up and nothing asks you for a rating. "Hide" still hides the whole line.
- The Marketplace description now opens with "Large JSON viewer with a fast JSON tree".

## 0.1.3 (2026-11-07)

- The "More free viewers" list and the README list now show the 15 Zovo extensions on the Marketplace under their current names, and 12 that are coming soon.
- Extensions for related files now come first, starting with JSONL Viewer & NDJSON Table Viewer and CSV Viewer, Excel Viewer & Parquet Viewer.

## 0.1.2 (2026-11-07)

- The Marketplace name is now "Large JSON Viewer & JSON Tree", so a search for large JSON finds it. The extension ID, settings and commands stay the same.

## 0.1.1 (2026-11-06)

- The bar at the bottom of the viewer ends with two small links, "Sponsor" (GitHub Sponsors) and "More free viewers". The new setting `jsonTreeViewer.showSupportLinks` (default `true`) hides them, and so does the "Hide" link next to them. There is no popup, and nothing is sent anywhere.
- New commands "JSON Viewer: Support the developer" and "JSON Viewer: More free viewers". The second one lists the other Zovo extensions and installs only the one you pick. Ones that are not on the Marketplace yet open their GitHub page.
- The listing gets a Sponsor button. The README has a short Support section and lists all Zovo extensions.

## 0.1.0 (2026-11-06)

First release.

- Read-only JSON tree for .json, .jsonc, .json5, .geojson, .har, .ipynb and .webmanifest files. It opens from the editor title or the Explorer and never replaces the text editor.
- Open the current selection or the clipboard as a tree.
- Virtual scrolling, child counts and type badges. Expand to level 1, 2, 3 or all.
- Search keys and values in the whole file, with next and previous.
- Copy a node's JSONPath, its JS path or its value.
- Arrays of objects open as a table with sortable columns.
- Strings that hold escaped JSON open as a nested tree.
- Comments and trailing commas (JSONC) and JSON5 are accepted. Parse errors show the line, the column and the text around it.
- Files are parsed in a worker thread. Files over 200 MB show a message and are not read (setting jsonTreeViewer.maxFileMB).
- One-time rating prompt after a few days of use (setting jsonTreeViewer.askForRating).
