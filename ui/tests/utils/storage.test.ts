// @vitest-environment jsdom
import {createElement, type ReactNode} from 'react';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
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
beforeEach(() => rpc.call.mockReset());

describe('Storage pages', () => {
    it('disables reads for listed oversized objects and enables reads for small objects', async () => {
        rpc.call.mockResolvedValue({
            objects: [
                {Key: 'large.txt', Size: 1024 * 1024 + 1},
                {Key: 'small.txt', Size: 2},
            ],
            nextContinuationToken: null,
        });
        render(createElement(NeonPanel, {connectionId: 'saved', serviceId: 'storage'}));
        fireEvent.click(screen.getByRole('button', {name: 'listObjects'}));
        await screen.findByText(/large\.txt/);
        const key = screen.getByLabelText('objectKey');
        fireEvent.change(key, {target: {value: 'large.txt'}});
        const read = screen.getByRole('button', {name: 'readObject'}) as HTMLButtonElement;
        expect(read.disabled).toBe(true);
        expect(read.title).toBe('storageReadTooLarge');
        expect(screen.getByText('storageReadTooLarge')).toBeTruthy();
        fireEvent.click(read);
        expect(rpc.call).toHaveBeenCalledTimes(1);
        fireEvent.change(key, {target: {value: 'small.txt'}});
        expect(read.disabled).toBe(false);
        fireEvent.click(read);
        await waitFor(() =>
            expect(rpc.call).toHaveBeenLastCalledWith('neon_storage_get', {key: 'small.txt'}),
        );
    });
    it('navigates bounded pages with the original prefix and resets tokens for a new listing', async () => {
        rpc.call.mockImplementation((_method, args) =>
            Promise.resolve({
                objects: [{Key: args?.continuationToken ? 'last.txt' : 'first.txt'}],
                nextContinuationToken: args?.continuationToken ? null : 'page-two',
            }),
        );
        render(createElement(NeonPanel, {connectionId: 'saved', serviceId: 'storage'}));
        fireEvent.change(screen.getByLabelText('prefix'), {
            target: {value: 'folder/'},
        });
        fireEvent.click(screen.getByRole('button', {name: 'listObjects'}));
        await screen.findByText(/first\.txt/);
        expect(rpc.call).toHaveBeenLastCalledWith('neon_storage_list', {
            prefix: 'folder/',
            continuationToken: undefined,
        });
        fireEvent.change(screen.getByLabelText('prefix'), {
            target: {value: 'new/'},
        });
        fireEvent.click(screen.getByRole('button', {name: 'storageNext'}));
        await screen.findByText(/last\.txt/);
        expect(screen.queryByText(/first\.txt/)).toBeNull();
        expect(rpc.call).toHaveBeenLastCalledWith('neon_storage_list', {
            prefix: 'folder/',
            continuationToken: 'page-two',
        });
        expect(
            (screen.getByRole('button', {name: 'storageNext'}) as HTMLButtonElement).disabled,
        ).toBe(true);
        fireEvent.click(screen.getByRole('button', {name: 'storagePrevious'}));
        await screen.findByText(/first\.txt/);
        expect(rpc.call).toHaveBeenLastCalledWith('neon_storage_list', {
            prefix: 'folder/',
            continuationToken: undefined,
        });
        fireEvent.click(screen.getByRole('button', {name: 'listObjects'}));
        await waitFor(() =>
            expect(rpc.call).toHaveBeenLastCalledWith('neon_storage_list', {
                prefix: 'new/',
                continuationToken: undefined,
            }),
        );
    });
    it('shows page failures without displaying an older page as the current one', async () => {
        rpc.call.mockResolvedValueOnce({
            objects: [{Key: 'first.txt'}],
            nextContinuationToken: 'page-two',
        });
        rpc.call.mockRejectedValueOnce(new Error('Storage page unavailable'));
        render(createElement(NeonPanel, {connectionId: 'saved', serviceId: 'storage'}));
        fireEvent.click(screen.getByRole('button', {name: 'listObjects'}));
        await screen.findByText(/first\.txt/);
        fireEvent.click(screen.getByRole('button', {name: 'storageNext'}));
        await screen.findByText('Storage page unavailable');
        expect(screen.queryByText(/first\.txt/)).toBeNull();
    });
});
