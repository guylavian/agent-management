import { managerView } from './ManagerPage';
import type { ManagerDetail } from '../api/types';

/**
 * THE CONSOLE AND THE RUNTIME ARE TWO PROCESSES ON TWO RELEASE CADENCES.
 *
 * During any rollout the console will, for minutes at a time, be talking to a
 * runtime that predates a contract change. Reading `manager.routable.length`
 * from a response with no `routable` took the entire page down with a white
 * screen — the worst possible way to report a version difference, because it
 * looks like the console is broken rather than merely ahead.
 */
const base = { id: 'manager', owner: 'sre-platform', lifecycle: 'active', modelProfile: 'manager-router', modelTier: 'small', promptFile: 'p.md', prompt: 'x', execution: {}, identity: { provider: 'none', reason: 'r' } } as unknown as ManagerDetail;

describe('managerView', () => {
  it('reads a current runtime straight through', () => {
    const view = managerView({ ...base, routable: ['keycloak'], notRouted: ['guy'], environment: 'production' } as ManagerDetail);
    expect(view).toEqual({ routable: ['keycloak'], notRouted: ['guy'], environment: 'production', known: true });
  });

  it('survives a runtime that does not send a derived routing table', () => {
    const view = managerView(base);
    expect(view.routable).toEqual([]);
    expect(view.notRouted).toEqual([]);
    // ABSENT IS NOT EMPTY. They render identically and mean opposite things:
    // one is "nothing is enabled here", the other is "nobody has said".
    expect(view.known).toBe(false);
  });

  it('distinguishes a genuinely empty routing table from an unknown one', () => {
    const empty = managerView({ ...base, routable: [], notRouted: [], environment: 'poc' } as ManagerDetail);
    expect(empty.known).toBe(true);
    expect(empty.routable).toEqual([]);
  });

  it('never renders "undefined" where an environment name belongs', () => {
    expect(managerView(base).environment).not.toContain('undefined');
  });
});
