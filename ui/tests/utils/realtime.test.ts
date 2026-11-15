// @vitest-environment jsdom
import {createElement, type ReactNode} from 'react';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {NeonPanel} from '../../src/NeonPanel';

const {rpc} = vi.hoisted(() => ({rpc: {call: vi.fn()}}));
vi.mock('../../src/UsagePanel', () => ({UsagePanel: () => null}));
vi.mock('../../src/components/DataTable', () => ({
    DataTable: ({data}: {data: {rows: unknown[][]}}) =>
        createElement('pre', null, JSON.stringify(data.rows)),
}));
vi.mock('@tabularis/plugin-api', () => ({
    usePluginTranslation: () => (key: string) => key,
    usePluginRpc: () => rpc,
    usePluginWorkspace: () => ({openWorkspace: vi.fn()}),
    PluginWorkspaceShell: ({children}: {children: ReactNode}) => children,
    PluginSelect: () => null,
}));
afterEach(cleanup);

describe('Realtime snapshot', () => {
    it('starts with a valid read that requires no application tables', async () => {
        rpc.call.mockResolvedValue([{value: 1}]);
        render(createElement(NeonPanel, {connectionId: 'saved', serviceId: 'realtime'}));
        expect((screen.getByLabelText('readQuery') as HTMLTextAreaElement).value).toBe(
            'SELECT 1 AS value',
        );
        fireEvent.click(screen.getByRole('button', {name: 'readSnapshot'}));
        await waitFor(() =>
            expect(rpc.call).toHaveBeenCalledWith('neon_realtime_snapshot', {
                query: 'SELECT 1 AS value',
            }),
        );
        await screen.findByText('[[1]]');
    });
});
