import { NotConfiguredError, RequestError } from './client';

/**
 * THE RUNTIME'S REASON MUST SURVIVE THE TRIP.
 *
 * A rejected draft comes back as `{ code, message, issues }` — the canonical
 * schema's own list of what is wrong, field by field. The client threw the
 * status line and dropped the body, so every validation failure in the console
 * read "Request failed: 400 Bad Request": the least useful message possible,
 * attached to the one class of error an operator can actually fix.
 */
describe('RequestError', () => {
  it('carries the field-by-field issues the runtime reported', () => {
    // the real payload from a draft with no MCP access selected: this is the
    // sentence the operator needs, and it is the one that used to be discarded
    const error = new RequestError(
      400,
      { code: 'AGENT_DRAFT_INVALID', message: 'Agent draft failed validation', issues: ['spec.access: Too small: expected array to have >=1 items'] },
      'Bad Request',
    );
    expect(error.issues).toEqual(['spec.access: Too small: expected array to have >=1 items']);
    expect(error.code).toBe('AGENT_DRAFT_INVALID');
    expect(error.message).toBe('Agent draft failed validation');
    // and never the status line, which is what the console showed instead
    expect(error.message).not.toContain('400');
  });

  it('falls back to the status line only when there is no body to quote', () => {
    // a proxy error page or an empty 502 is normal; inventing an issue list
    // here would send someone to edit a field that is perfectly fine
    const error = new RequestError(502, {}, 'Bad Gateway');
    expect(error.message).toBe('Request failed: 502 Bad Gateway');
    expect(error.issues).toBeUndefined();
  });

  it('is shaped so the pages can read it without knowing it exists', () => {
    // every page catch does `body.issues ?? [body.message]`; this is the
    // contract that makes those work unchanged
    const body = new RequestError(400, { message: 'nope', issues: ['a: bad'] }, 'Bad Request') as { issues?: string[]; message?: string };
    expect(body.issues ?? [body.message]).toEqual(['a: bad']);
  });

  it('stays distinct from a deployment that has no runtime wired', () => {
    // 501 is "nobody configured this", not "your draft is wrong", and the
    // console says so rather than showing an empty validation panel
    expect(new NotConfiguredError('baseUrl is not set').reason).toBe('baseUrl is not set');
  });
});
