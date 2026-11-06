# Changelog

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
