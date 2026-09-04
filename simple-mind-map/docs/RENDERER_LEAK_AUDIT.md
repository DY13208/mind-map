# Renderer Leak Audit

Framework only. **Browser soak not run.** Do not treat Node freeze PASS as leak PASS.

| Target | Status |
| --- | --- |
| Layout switch ×20 DOM/SVG | Not executed |
| Move/Delete/Undo ×50 caches | Node tests exist; browser not soak |
| Generalization / AssociativeLine helpers | Node tests; SVG recycle unmeasured |
| room open/close ×20 listeners | Not executed |
| Timers after unmount | Not executed |

`test:collab:v2:soak` is PG/socket skeleton, not a 30m/1h browser metric.
