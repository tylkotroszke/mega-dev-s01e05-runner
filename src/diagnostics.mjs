// Only controller-owned errors carry metadata. Never log message/cause from
// transport, tracker, model output, test source or sandbox stdout/stderr.
const details = new WeakMap();
const codes = new Set([
  'model_timeout', 'model_http_error', 'model_transport_error',
  'model_invalid_response', 'model_blocked', 'model_incomplete',
  'test_generation_unavailable', 'invalid_generated_test',
  'sandbox_timeout', 'sandbox_failed', 'result_failed', 'processing_failed',
]);
const reasons = new Set(['MAX_TOKENS', 'SAFETY', 'RECITATION', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MALFORMED_FUNCTION_CALL']);

export function diagnosticError(message, code, metadata = {}) {
  if (!codes.has(code)) throw new Error('invalid diagnostic code');
  const error = new Error(message);
  const safe = {code};
  if (Number.isInteger(metadata.httpStatus) && metadata.httpStatus >= 100 && metadata.httpStatus <= 599) safe.httpStatus = metadata.httpStatus;
  if (reasons.has(metadata.finishReason)) safe.finishReason = metadata.finishReason;
  details.set(error, Object.freeze(safe));
  return error;
}

export function diagnosticDetails(error, fallback = 'processing_failed') {
  return {...(details.get(error) ?? {code: codes.has(fallback) ? fallback : 'processing_failed'})};
}

export function preserveDiagnostic(error, message, fallback) {
  const {code, ...metadata} = diagnosticDetails(error, fallback);
  return diagnosticError(message, code, metadata);
}
