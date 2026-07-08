"use strict";

/**
 * Wrap an async Express handler so rejected promises reach the error
 * handler middleware instead of crashing the process or hanging the request.
 *
 *   app.post("/x", asyncWrapper(async (req, res) => { ... }));
 */
function asyncWrapper(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

module.exports = asyncWrapper;
