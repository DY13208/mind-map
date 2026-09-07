# C2 Large Map Baseline

Generated: 2026-09-07T01:48:21.455Z

importMaxNodes=20000

| size | nodeCount | encodeBeforeMs | encodeMs | encodeSpeedup | replaceBeforeMs | pgBulkWriteMs | replaceSpeedup | pgQueryCount | hydrateDecodeMs | payloadBytes | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1000 | 1000 | 38.55 | 6.09 | 6.33 | 43.58 | 2.11 | 20.65 | 3 | 11.15 | 114437 | PASS |
| 5000 | 5000 | 2004.45 | 33.22 | 60.34 | 2137.19 | 4.31 | 495.87 | 3 | 7.7 | 589933 | PASS |
| 10000 | 10000 | 10679.74 | 70.86 | 150.72 | 10408.99 | 8.18 | 1272.49 | 3 | 12.01 | 1184308 | PASS |
| 20000 | 20000 | 56457.54 | 96.67 | 584.02 | 56204.05 | 20.71 | 2713.86 | 3 | 30.31 | 2413054 | PASS |

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
