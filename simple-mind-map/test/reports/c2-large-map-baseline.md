# C2 Large Map Baseline

Generated: 2026-09-07T06:09:50.378Z

importMaxNodes=20000

| size | nodeCount | encodeBeforeMs | encodeMs | encodeSpeedup | replaceBeforeMs | pgBulkWriteMs | replaceSpeedup | pgQueryCount | hydrateDecodeMs | payloadBytes | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1000 | 1000 | 38.55 | 5.85 | 6.59 | 43.58 | 2.75 | 15.85 | 3 | 10 | 114437 | PASS |
| 5000 | 5000 | 2004.45 | 34.43 | 58.22 | 2137.19 | 5.27 | 405.54 | 3 | 8.76 | 589933 | PASS |
| 10000 | 10000 | 10679.74 | 59.01 | 180.98 | 10408.99 | 8.97 | 1160.42 | 3 | 12.64 | 1184308 | PASS |
| 20000 | 20000 | 56457.54 | 96.06 | 587.73 | 56204.05 | 21.69 | 2591.24 | 3 | 30.12 | 2413054 | PASS |

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
