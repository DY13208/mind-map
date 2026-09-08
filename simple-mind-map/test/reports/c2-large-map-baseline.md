# C2 Large Map Baseline

Generated: 2026-09-07T07:45:24.135Z

importMaxNodes=20000

| size | nodeCount | encodeBeforeMs | encodeMs | encodeSpeedup | replaceBeforeMs | pgBulkWriteMs | replaceSpeedup | pgQueryCount | hydrateDecodeMs | payloadBytes | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1000 | 1000 | 38.55 | 2.52 | 15.3 | 43.58 | 0.97 | 44.93 | 3 | 4.93 | 114437 | PASS |
| 5000 | 5000 | 2004.45 | 11.8 | 169.87 | 2137.19 | 1.82 | 1174.28 | 3 | 2.04 | 589933 | PASS |
| 10000 | 10000 | 10679.74 | 16.4 | 651.2 | 10408.99 | 3.29 | 3163.83 | 3 | 2.64 | 1184308 | PASS |
| 20000 | 20000 | 56457.54 | 29.21 | 1932.82 | 56204.05 | 8.76 | 6415.99 | 3 | 5.63 | 2413054 | PASS |

## Summary

```
{
  "LARGE_MAP_1K": "PASS",
  "LARGE_MAP_5K": "PASS",
  "LARGE_MAP_10K": "PASS",
  "LARGE_MAP_20K": "PASS",
  "PG_BULK_WRITE": "PASS",
  "IMPORT_PERFORMANCE": "PASS",
  "ENCODE_DOUBLE_WORK_FIXED": "YES",
  "F5_RECOVERY": "PASS",
  "OVERSIZE_SAFE_FAIL": "PASS"
}
```
