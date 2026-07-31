/**
 * Injected into every module by build.mjs (esbuild `inject`).
 *
 * @scrypted/client's RPC serializers use Node's Buffer global - Buffer.from,
 * Buffer.concat and Buffer.alloc in rpc-serializer.js and
 * rpc-buffer-serializer.js. That is the browser code path, not a server-only
 * file, so stubbing `buffer` is not an option: the real implementation has to
 * be bundled.
 *
 * If a future @scrypted/client needs `process` beyond the `process.arch` and
 * `process.env.NODE_ENV` replacements in build.mjs, add it here as well.
 */
export { Buffer } from 'buffer';
