// Incremental graph update service. The implementation already lives in
// graphUpdateExecutor.ts (created in prior work); this module is the named
// service entry point and re-exports it to avoid duplicating logic.

export { applyGraphUpdate } from "./graphUpdateExecutor.js";
