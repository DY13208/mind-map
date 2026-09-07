# SimpleMindMap V2 Compatibility Matrix

`COLLABORATION_V2_CORE_FROZEN = YES`. Node freeze PASS ≠ full PG/browser/F5 matrix.

| Feature | Status |
| --- | --- |
| Core insert/move/delete | Node PASS |
| Text / search replace | Node PASS |
| Paste / cut | Node PASS |
| Style / map meta | Node PASS |
| Generalization / special objects | Node PASS |
| RichText F5 literal HTML | **Fixed on current main** — C4 must not roll back |
| Import / Export | Partial; export background unit test from C4 |
| ACL | Node + integration (env) |
| History restore / bootstrap | Separate `test:collab:history` |
| File system | Separate `test:collab:files` |
