---
'@tanstack/solid-query': patch
---

Use Query Core as a required peer dependency, with support for versions `>=5.102.0 <6.0.0`, so Solid Query and host integrations share the same QueryClient and cache types.

Preserve query key data and error branding when inferred `queryOptions` and `infiniteQueryOptions` results are emitted as declarations and consumed by another package.
