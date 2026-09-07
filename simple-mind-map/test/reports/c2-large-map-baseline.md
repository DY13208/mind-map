# C2 Large Map Baseline

Generated: 2026-09-07T03:12:51.164Z

importMaxNodes=20000

| size | nodeCount | encodeBeforeMs | encodeMs | encodeSpeedup | replaceBeforeMs | pgBulkWriteMs | replaceSpeedup | pgQueryCount | hydrateDecodeMs | payloadBytes | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1000 | 1000 | 38.55 | 6.73 | 5.73 | 43.58 | 2.44 | 17.86 | 3 | 11.44 | 114437 | PASS |
| 5000 | 5000 | 2004.45 | 40.36 | 49.66 | 2137.19 | 4.76 | 448.99 | 3 | 8.9 | 589933 | PASS |
| 10000 | 10000 | 10679.74 | 69.43 | 153.82 | 10408.99 | 8.52 | 1221.71 | 3 | 12.52 | 1184308 | PASS |
| 20000 | 20000 | 56457.54 | 104.04 | 542.65 | 56204.05 | 23.47 | 2394.72 | 3 | 29.55 | 2413054 | PASS |

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
