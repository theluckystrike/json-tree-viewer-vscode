# Tables and escaped JSON

- An array of objects shows a "Table" chip. The table has one column per key. Click a header to sort, and click it again to reverse or clear the sort.
- A string that holds escaped JSON, like a log payload or a HAR response body, shows a "JSON string" chip. Click it to open the string as a tree. Copy JS path then gives `JSON.parse(data.events[0].payload).user.id`.
