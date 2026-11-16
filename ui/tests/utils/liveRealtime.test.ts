// @vitest-environment jsdom
import {createElement} from 'react';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {useLiveRealtime} from '../../src/hooks/useLiveRealtime';
const rpc = vi.hoisted(() => ({call: vi.fn()}));
vi.mock('@tabularis/plugin-api', () => ({usePluginRpc: () => rpc}));
function Harness() {
    const live = useLiveRealtime('connection');
    return createElement(
        'div',
        null,
        createElement('button', {onClick: () => void live.start('SELECT 1')}, 'Start'),
        createElement('button', {onClick: live.stop}, 'Stop'),
        createElement('pre', null, JSON.stringify(live.result)),
        live.error && createElement('p', {role: 'alert'}, live.error),
    );
}
beforeEach(() => rpc.call.mockReset());
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});
it('keeps updating one subscription and stops it on user action', async () => {
    let revision = 1;
    rpc.call.mockImplementation(async (method) =>
        method === 'neon_realtime_start'
            ? {id: 'live', revision: 1, status: 'live', rows: [{value: 1}]}
            : method === 'neon_realtime_poll'
              ? {id: 'live', revision: ++revision, status: 'live', rows: [{value: revision}]}
              : null,
    );
    render(createElement(Harness));
    fireEvent.click(screen.getByText('Start'));
    await waitFor(() => expect(screen.getByText(/"value":1/)).toBeTruthy());
    vi.useFakeTimers();
    await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
    });
    // The initial timer was installed before fake timers; restart to install the controlled timer.
    fireEvent.click(screen.getByText('Stop'));
    fireEvent.click(screen.getByText('Start'));
    await act(async () => {
        await Promise.resolve();
    });
    await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
    });
    expect(screen.getByText(/"value":2/)).toBeTruthy();
    fireEvent.click(screen.getByText('Stop'));
    expect(rpc.call).toHaveBeenCalledWith('neon_realtime_stop', {id: 'live'});
    const count = rpc.call.mock.calls.filter(([method]) => method === 'neon_realtime_poll').length;
    await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
    });
    expect(rpc.call.mock.calls.filter(([method]) => method === 'neon_realtime_poll')).toHaveLength(
        count,
    );
});
it('cleans up a subscription whose start finishes after its frame unmounts', async () => {
    let resolve!: (value: unknown) => void;
    rpc.call.mockImplementation((method) =>
        method === 'neon_realtime_start'
            ? new Promise((r) => {
                  resolve = r;
              })
            : Promise.resolve(null),
    );
    const view = render(createElement(Harness));
    fireEvent.click(screen.getByText('Start'));
    view.unmount();
    await act(async () => {
        resolve({id: 'late', revision: 1, status: 'connecting'});
        await Promise.resolve();
    });
    expect(rpc.call).toHaveBeenCalledWith('neon_realtime_stop', {id: 'late'});
});
