/**
 * Version strings. INFO and HELLO report Redis's version so client libraries enable the right
 * features (spec 7.6), plus our own.
 *
 * Key design choice: constants in source rather than read from package.json, so the built
 * server needs no file outside dist/ and the version shows up in a grep.
 *
 * Mirrors Redis version.h.
 */

export const REDIS_VERSION = '7.4.0';
export const MINIREDIS_VERSION = '0.1.0';
