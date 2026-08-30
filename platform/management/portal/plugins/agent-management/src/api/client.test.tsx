import { act, render, screen, waitFor } from '@testing-library/react';
import { RECONCILE_POLL_MS, usePolled } from './client';

/**
 * NO MANUAL REFRESH.
 *
 * Merging a pull request starts a sequence nobody drives from the browser:
 * Argo syncs, a pod starts, the Manager's catalog picks the Agent up. The
 * console used to fetch once on mount and stay there, so the only way to see a
 * merge take effect was to know to press reload — and an operator watching a
 * deployment that has silently failed will reload for a while before they start
 * to doubt the page rather than the deployment.
 */
function Probe({ load }: { load: () => Promise<string> }) {
  const state = usePolled(load, [], 1_000);
  return (
    <div>
      <span data-testid="value">{state.value ?? 'none'}</span>
      <span data-testid="loading">{String(state.loading)}</span>
      <span data-testid="error">{state.error?.message ?? 'none'}</span>
      <span data-testid="refreshError">{state.refreshError?.message ?? 'none'}</span>
    </div>
  );
}

describe('usePolled', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('re-fetches on an interval without the page being reloaded', async () => {
    let value = 'reconciling';
    const load = jest.fn(async () => value);
    render(<Probe load={load} />);
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('reconciling'));

    // the deployment finishes while the operator is looking at the page
    value = 'active';
    await act(async () => { jest.advanceTimersByTime(1_000); });
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('active'));
  });

  it('keeps the previous value on screen while refreshing', async () => {
    let resolve: (value: string) => void = () => {};
    let first = true;
    const load = jest.fn(async () => {
      if (first) { first = false; return 'active'; }
      return new Promise<string>(done => { resolve = done; });
    });
    render(<Probe load={load} />);
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('active'));

    await act(async () => { jest.advanceTimersByTime(1_000); });
    // a poll that blanked the table every few seconds would be worse than no
    // poll at all, so `loading` is the FIRST load only
    expect(screen.getByTestId('value').textContent).toBe('active');
    expect(screen.getByTestId('loading').textContent).toBe('false');
    await act(async () => { resolve('degraded'); });
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('degraded'));
  });

  it('stops polling while the tab is hidden', async () => {
    const load = jest.fn(async () => 'active');
    render(<Probe load={load} />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    const hidden = jest.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () => { jest.advanceTimersByTime(5_000); });
    expect(load).toHaveBeenCalledTimes(1);

    // and resumes on the next tick, without needing the component to remount
    hidden.mockReturnValue(false);
    await act(async () => { jest.advanceTimersByTime(1_000); });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it('polls faster than a human would give up waiting', () => {
    expect(RECONCILE_POLL_MS).toBeLessThanOrEqual(15_000);
  });

  it('does not replace a working page with an error because one poll failed', async () => {
    let fail = false;
    const load = jest.fn(async () => {
      if (fail) throw new Error('network');
      return 'active';
    });
    render(<Probe load={load} />);
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('active'));

    fail = true;
    await act(async () => { jest.advanceTimersByTime(1_000); });
    // the data survives, and the failure is reported beside it rather than
    // instead of it — a dropped request is not the same as "you have no agents"
    await waitFor(() => expect(screen.getByTestId('refreshError').textContent).toBe('network'));
    expect(screen.getByTestId('value').textContent).toBe('active');
    expect(screen.getByTestId('error').textContent).toBe('none');
  });
});
