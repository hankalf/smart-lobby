'use strict';
/**
 * Make an async route fail the way a synchronous one does.
 *
 * Express 4 catches what a handler throws and hands it to the error middleware.
 * It does not catch what a handler's *promise* rejects with — it never sees the
 * promise at all. So an `async` handler that throws produces an unhandled
 * rejection, and Node's default answer to an unhandled rejection is to end the
 * process.
 *
 * Which is what happened. One admin route built a notification the old way,
 * read a property of undefined, and pressing its Test button took the whole
 * server down: every tablet mid-sign-in lost its request, and on a host that
 * restarts automatically the only evidence was a button that appeared to do
 * nothing. A visitor management system that can be stopped by a button in its
 * own settings is not one anybody should run a gate on.
 *
 * So every handler registered on a guarded router gets its rejection routed to
 * `next`, which is where a thrown error already goes: the request answers 500,
 * the reason is logged once by the error middleware, and the process carries
 * on serving the gate. The bug is still a bug — this decides what it costs.
 */

const METHODS = ['use', 'all', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function wrap(handler) {
  if (typeof handler !== 'function') return handler;
  /*
   * Express tells error middleware apart by arity, and a mounted router is a
   * function carrying its own routing table. Neither is ours to rewrap: the
   * first would stop being an error handler, and the second would arrive as a
   * plain function with its stack left behind.
   */
  if (handler.length >= 4) return handler;
  if (handler.stack || handler.handle) return handler;

  const guarded = function (req, res, next) {
    let out;
    try {
      out = handler.call(this, req, res, next);
    } catch (err) {
      next(err);
      return undefined;
    }
    if (out && typeof out.then === 'function') out.then(undefined, next);
    return out;
  };
  // Arity is load-bearing in Express, and the name is what makes a stack trace
  // worth reading.
  Object.defineProperty(guarded, 'length', { value: handler.length });
  Object.defineProperty(guarded, 'name', { value: handler.name || 'handler' });
  return guarded;
}

/**
 * Guard every handler registered on a router or app from here on.
 *
 * Applied to the router itself rather than to each route, because the point is
 * that nobody has to remember: a route added next year is covered by having
 * been added at all.
 */
function guard(router) {
  for (const method of METHODS) {
    const original = router[method];
    if (typeof original !== 'function') continue;
    router[method] = function (...args) { return original.apply(this, args.map(wrap)); };
  }
  return router;
}

module.exports = { guard };
