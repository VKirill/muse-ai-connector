// The version must be a compile-time literal: BB ships host.mjs alone, so a
// runtime package.json read there has nothing to find and silently falls back.
export const PLUGIN_VERSION = "0.3.4";
