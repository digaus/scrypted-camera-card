import esbuild from 'esbuild';
import { builtinModules } from 'node:module';
import { readFileSync } from 'node:fs';

const dev = process.argv.includes('--watch');

// package.json is the one place the version lives. Injected here rather than written
// into src/card.js, because a second literal is how a card ends up displaying a
// version it is not - and the release workflow checks this same field against the
// pushed tag, so the number on screen is the number that was released.
const { version } = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8'));

/**
 * @scrypted/client targets Node and the browser from one entry point, so esbuild
 * drags in axios' Node HTTP adapter and its dependencies. Those code paths never
 * execute in a browser - axios picks the XHR adapter at runtime - they just have
 * to resolve.
 *
 * The stub is a Proxy rather than an empty object on purpose: follow-redirects
 * does `require("stream").Writable` at module scope and inherits from it, so a
 * bare {} would throw during import. Every property returns a callable with a
 * prototype instead, which is enough to get through module initialisation.
 */
// Genuinely needed in the browser, so these get a real implementation instead of
// a stub - see src/shims/node-globals.js.
const POLYFILLED = new Set(['buffer']);

const NODE_ONLY = [
  ...builtinModules.filter((m) => !POLYFILLED.has(m)),
  // node-only npm packages reachable from the client's server fetch path
  'follow-redirects', 'form-data', 'proxy-from-env',
];

const stubNodeOnly = {
  name: 'stub-node-only',
  setup(build) {
    const filter = new RegExp(`^(node:)?(${NODE_ONLY.join('|')})(/.*)?$`);
    const stubbed = new Set();

    build.onResolve({ filter }, (args) => {
      stubbed.add(args.path);
      return { path: args.path, namespace: 'node-stub' };
    });

    build.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => ({
      loader: 'js',
      contents: `
        const stub = new Proxy(function () {}, {
          get: (target, prop) => {
            if (prop === 'default' || prop === '__esModule') return stub;
            if (prop === 'prototype') return target.prototype;
            return stub;
          },
          construct: () => ({}),
          apply: () => stub,
        });
        module.exports = stub;
      `,
    }));

    // Silent stubs are how "it built fine but breaks at runtime" happens.
    // Print them so an unexpected entry is visible instead of assumed harmless.
    build.onEnd(() => {
      if (stubbed.size) {
        console.log('stubbed as node-only:', [...stubbed].sort().join(', '));
      }
    });
  },
};

const options = {
  entryPoints: ['src/card.js'],
  outfile: 'dist/scrypted-camera-card.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  plugins: [stubNodeOnly],
  inject: ['src/shims/node-globals.js'],
  define: {
    // @scrypted/client picks its HTTP implementation by trying to require Node
    // builtins and falling back to fetch when that throws. Since the stubs above
    // make those requires *succeed*, that detection would wrongly select the
    // Node path. This is the package's own browser switch - it makes the try
    // block throw immediately, so domFetch is used.
    'process.arch': '"browser"',
    'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
    global: 'globalThis',
    __CARD_VERSION__: JSON.stringify(version),
  },
  minify: !dev,
  sourcemap: dev,
  logLevel: 'info',
};

if (dev) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching…');
} else {
  await esbuild.build(options);
}
