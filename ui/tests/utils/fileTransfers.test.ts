// @vitest-environment jsdom
import {createElement} from 'react';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {StorageFileTransfer} from '../../src/components/StorageFileTransfer';
const rpc = vi.hoisted(() => ({call: vi.fn()}));
vi.mock('@tabularis/plugin-api', () => ({
    usePluginRpc: () => rpc,
    usePluginTranslation: () => (key: string) => key,
}));
beforeEach(() => rpc.call.mockReset());
afterEach(cleanup);
const mount = () =>
    render(
        createElement(StorageFileTransfer, {
            connectionId: 'connection',
            bucket: 'media',
            prefix: 'photos/',
            onUploaded: vi.fn(),
        }),
    );
const choose = () =>
    fireEvent.change(screen.getByLabelText('files.file'), {
        target: {
            files: [
                new File([new Uint8Array([0, 255, 1, 42])], 'test.bin', {
                    type: 'application/octet-stream',
                }),
            ],
        },
    });
it('waits for confirmation, then uploads exact binary chunks and completes', async () => {
    rpc.call.mockImplementation(async (method, args) =>
        method === 'neon_storage_upload_start'
            ? {id: 'upload', chunkBytes: 2}
            : method === 'neon_storage_upload_chunk'
              ? {offset: args.offset + Buffer.from(args.data, 'base64').length}
              : {},
    );
    mount();
    choose();
    fireEvent.click(screen.getByText('files.upload'));
    expect(rpc.call).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('files.confirmUpload'));
    await screen.findByText('files.uploaded');
    expect(rpc.call).toHaveBeenCalledWith('neon_storage_upload_start', {
        bucket: 'media',
        key: 'photos/test.bin',
        size: 4,
        contentType: 'application/octet-stream',
    });
    const chunks = rpc.call.mock.calls
        .filter(([method]) => method === 'neon_storage_upload_chunk')
        .map(([, args]) => Buffer.from(args.data, 'base64'));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([0, 255, 1, 42]));
    expect(rpc.call).toHaveBeenCalledWith('neon_storage_upload_complete', {id: 'upload'});
    expect(rpc.call.mock.calls.some(([method]) => method === 'neon_storage_upload_abort')).toBe(
        false,
    );
});
it('aborts the remote upload and never completes after cancellation', async () => {
    let resolve!: (value: unknown) => void;
    rpc.call.mockImplementation((method) =>
        method === 'neon_storage_upload_start'
            ? Promise.resolve({id: 'upload', chunkBytes: 2})
            : method === 'neon_storage_upload_chunk'
              ? new Promise((r) => {
                    resolve = r;
                })
              : Promise.resolve(null),
    );
    mount();
    choose();
    fireEvent.click(screen.getByText('files.upload'));
    fireEvent.click(screen.getByText('files.confirmUpload'));
    await waitFor(() =>
        expect(rpc.call.mock.calls.some(([m]) => m === 'neon_storage_upload_chunk')).toBe(true),
    );
    fireEvent.click(screen.getByRole('button', {name: 'files.cancel'}));
    expect(rpc.call).toHaveBeenCalledWith('neon_storage_upload_abort', {id: 'upload'});
    await act(async () => {
        resolve({offset: 2});
        await Promise.resolve();
    });
    await screen.findByText('files.cancelled');
    expect(rpc.call.mock.calls.some(([method]) => method === 'neon_storage_upload_complete')).toBe(
        false,
    );
});
