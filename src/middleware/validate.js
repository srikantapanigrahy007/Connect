/**
 * Wraps a handler with Zod validation of body/query/params. Invalid input becomes a
 * 400 VALIDATION_ERROR through the central error handler; values are never echoed back.
 */
export function validated(schemas, handler) {
  return async (req, res) => {
    const input = {};
    if (schemas.body) input.body = await schemas.body.parseAsync(req.body ?? {});
    if (schemas.query) input.query = await schemas.query.parseAsync(req.query);
    if (schemas.params) input.params = await schemas.params.parseAsync(req.params);
    await handler(req, res, input);
  };
}
