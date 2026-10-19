---
'@tanstack/query-devtools': patch
'@tanstack/query-persist-client-core': patch
'@tanstack/solid-query-devtools': patch
'@tanstack/solid-query-persist-client': patch
---

Use the caller's Query Core peer for devtools and persistence instead of installing a separate cache runtime. Keep workspace development on its existing Core and give Solid 2 wrappers their own injected provider context, so their QueryClient types and caches use the same Core as Solid Query.

Build Solid 2 wrappers directly with the native Solid 2 compiler while preserving development, production, CommonJS, ESM and JSX outputs, without installing the obsolete Solid 1 compiler preset.
