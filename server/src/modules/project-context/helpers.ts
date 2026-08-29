/**
 * project-context — the module's pure helpers.
 *
 * The path and type primitives themselves live in
 * `src/adapters/projectcontext/paths.ts` because three adapters need them and
 * `adapters-stay-outermost` forbids an adapter importing a module's
 * `helpers.ts`. They are re-exported here so module code (service, routes,
 * tests) has one import path — the same shape `modules/reviews/helpers.ts` uses
 * to re-export `reduceReviews` / `sliceDiff` from the engine.
 */
export {
  docTypeForRoot,
  isMarkdown,
  toRepoRelative,
  resolveWithinRoots,
  assertWithinCheckout,
} from '../../adapters/projectcontext/paths.js';
