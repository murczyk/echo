# React browser performance-test disposition

`npm run e2e:perf` is a non-blocking local inspection, not a CI gate. The
suite has no documented reproducible performance budget or controlled
environment yet, so its thresholds must not be changed to force a pass.

On 2026-09-15, one-worker/no-retry inspection passed the two Analysis cases
and the Duty comparison. The Classic Callsigns, Palitras, and Messenger cases
failed before measuring performance because their expected legacy page headings
were unavailable. This is a fixture/route-availability disposition, not proof
of a performance regression.

Enable these tests only after defining a stable environment, measurement
method, baseline budget, and route fixtures for both sides of each comparison.
