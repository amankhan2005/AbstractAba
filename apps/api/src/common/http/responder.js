/**
 * Uniform success envelopes, ported from the original API contract:
 *   single resource   -> { data }
 *   paginated list     -> { data, meta }
 * Errors use { error: { code, message, details? } } via the error handler.
 *
 * The original API always wrapped payloads this way; reproducing it keeps the
 * request/response contract byte-compatible for clients and the frontend.
 */
export function sendSuccess(res, data, status = 200) {
  // `data` must never be absent from the envelope. A handler that computes
  // nothing — or returns undefined from a service that found nothing —
  // serialises to `{}` in JSON, and the web client's `response.data.data` is
  // then `undefined`. React Query rejects an undefined result outright with
  // "Query data cannot be undefined", which surfaces as a broken screen rather
  // than as an empty one. Normalising here fixes it for all ~139 client
  // functions at once instead of guarding each call site.
  res.status(status).json({ data: data ?? null });
}

/** 201 with a Location header, mirroring the original sendCreated. */
export function sendCreated(res, data, location) {
  if (location) res.set('Location', location);
  res.status(201).json({ data: data ?? null });
}

/** A paginated collection: data + pagination meta (nextCursor, limit). */
export function sendPaginated(res, data, meta, status = 200) {
  // A collection endpoint returns a LIST, never null: "no results" is an empty
  // array, and a client mapping over the response must not have to check.
  res.status(status).json({ data: data ?? [], meta: meta ?? null });
}

/** 204 No Content. */
export function sendNoContent(res) {
  res.status(204).end();
}
