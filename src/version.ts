/**
 * ccalyze version, embedded in source rather than read from package.json.
 *
 * The skill bundle (`npm run bundle-skill`) ships only the compiled JS, without
 * the repo's package.json — so a fetched copy still needs to be able to report
 * which build it is. A vendored copy drifts from the repo by design; `--version`
 * is how a user tells whether theirs is current.
 *
 * Kept in sync with package.json by a test.
 */
export const VERSION = '0.4.0';
