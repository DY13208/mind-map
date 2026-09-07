# C2 Large Map Baseline

Generated: 2026-09-07T02:34:49.034Z

importMaxNodes=20000

| size | nodeCount | encodeBeforeMs | encodeMs | encodeSpeedup | replaceBeforeMs | pgBulkWriteMs | replaceSpeedup | pgQueryCount | hydrateDecodeMs | payloadBytes | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1000 | 1000 | 38.55 | 6.34 | 6.08 | 43.58 | 2.28 | 19.11 | 3 | 9.81 | 114437 | PASS |
| 5000 | 5000 | 2004.45 | 34.14 | 58.71 | 2137.19 | 4.23 | 505.25 | 3 | 8.07 | 589933 | PASS |
| 10000 | 10000 | 10679.74 | 50.53 | 211.35 | 10408.99 | 7.51 | 1386.02 | 3 | 13.19 | 1184308 | PASS |
| 20000 | 20000 | 56457.54 | 93.75 | 602.21 | 56204.05 | 21.9 | 2566.39 | 3 | 29.85 | 2413054 | PASS |

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
