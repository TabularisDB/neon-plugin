import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    storageTransfer,
    STORAGE_CHUNK_BYTES,
    STORAGE_MAX_FILE_BYTES,
} from '../dist/storageTransfers.js';
import {withCredentials} from '../dist/env.js';

const credentials = {
    AWS_ENDPOINT_URL_S3: 'https://storage.example.invalid',
    AWS_REGION: 'auto',
    AWS_ACCESS_KEY_ID: 'test-access',
    AWS_SECRET_ACCESS_KEY: 'dummy-private-key',
};
function fixture() {
    const calls = [],
        parts = [];
    let destroyed = 0,
        failPart = false,
        failComplete = false,
        failAbort = false;
    const client = {
        destroy() {
            destroyed++;
        },
        async send(command) {
            const name = command.constructor.name,
                input = command.input;
            calls.push({name, input});
            if (name === 'CreateMultipartUploadCommand') return {UploadId: 'upload'};
            if (name === 'UploadPartCommand') {
                if (failPart) {
                    failPart = false;
                    throw new Error('dummy-private-key');
                }
                parts[input.PartNumber - 1] = Buffer.from(input.Body);
                return {ETag: 'part-' + input.PartNumber, ChecksumCRC32: 'AAAAAA=='};
            }
            if (name === 'AbortMultipartUploadCommand' && failAbort) {
                failAbort = false;
                throw new Error('temporary abort failure');
            }
            if (name === 'CompleteMultipartUploadCommand' && failComplete)
                throw new Error('lost response');
            if (name === 'HeadObjectCommand')
                return {
                    Metadata: calls.find((c) => c.name === 'CreateMultipartUploadCommand').input
                        .Metadata,
                    ContentLength: parts.reduce((n, p) => n + p.length, 0),
                };
            return {};
        },
    };
    return {
        connect: () => client,
        calls,
        parts,
        destroyed: () => destroyed,
        failPart() {
            failPart = true;
        },
        loseComplete() {
            failComplete = true;
        },
        failAbort() {
            failAbort = true;
        },
    };
}
const call = (method, args, f, owner = 'connection', secrets = credentials) =>
    withCredentials(secrets, () => storageTransfer(method, args, owner, f?.connect));

test('Storage uploads binary multipart data exactly once and acknowledges repeated chunks/completion', async () => {
    const f = fixture(),
        bytes = Buffer.alloc(6 * 1024 * 1024 + 17, 0xff);
    const started = await call(
        'neon_storage_upload_start',
        {
            bucket: 'media',
            key: 'images/blob.bin',
            size: bytes.length,
            contentType: 'application/octet-stream',
        },
        f,
    );
    try {
        assert.equal(started.chunkBytes, STORAGE_CHUNK_BYTES);
        const first = {
            id: started.id,
            offset: 0,
            data: bytes.subarray(0, STORAGE_CHUNK_BYTES).toString('base64'),
        };
        await call('neon_storage_upload_chunk', first, f);
        assert.equal(
            (await call('neon_storage_upload_chunk', first, f)).offset,
            STORAGE_CHUNK_BYTES,
        );
        await assert.rejects(
            call('neon_storage_upload_complete', {id: started.id}, f),
            /incomplete/,
        );
        for (let offset = STORAGE_CHUNK_BYTES; offset < bytes.length; offset += STORAGE_CHUNK_BYTES)
            await call(
                'neon_storage_upload_chunk',
                {
                    id: started.id,
                    offset,
                    data: bytes.subarray(offset, offset + STORAGE_CHUNK_BYTES).toString('base64'),
                },
                f,
            );
        const result = await call('neon_storage_upload_complete', {id: started.id}, f);
        assert.deepEqual(result, {key: 'images/blob.bin', size: bytes.length});
        assert.deepEqual(await call('neon_storage_upload_complete', {id: started.id}, f), result);
        assert(Buffer.concat(f.parts).equals(bytes));
        assert.equal(f.parts.length, 2);
        assert.equal(f.calls.filter((c) => c.name === 'CompleteMultipartUploadCommand').length, 1);
        assert.equal(
            f.calls.find((c) => c.name === 'CompleteMultipartUploadCommand').input.MultipartUpload
                .Parts[0].ChecksumCRC32,
            'AAAAAA==',
        );
        assert.equal(f.destroyed(), 1);
    } finally {
        await call('neon_storage_upload_abort', {id: started.id}, f);
    }
});

test('Storage part retries do not duplicate bytes after a failed or lost part response', async () => {
    const f = fixture(),
        bytes = Buffer.alloc(5 * 1024 * 1024, 42);
    const {id} = await call('neon_storage_upload_start', {key: 'retry.bin', size: bytes.length}, f);
    try {
        for (let offset = 0; offset < bytes.length; offset += STORAGE_CHUNK_BYTES) {
            const args = {
                id,
                offset,
                data: bytes.subarray(offset, offset + STORAGE_CHUNK_BYTES).toString('base64'),
            };
            if (offset + STORAGE_CHUNK_BYTES === bytes.length) {
                f.failPart();
                await assert.rejects(
                    call('neon_storage_upload_chunk', args, f),
                    (e) => !e.message.includes('dummy-private-key'),
                );
            }
            await call('neon_storage_upload_chunk', args, f);
        }
        f.loseComplete();
        await call('neon_storage_upload_complete', {id}, f);
        assert(Buffer.concat(f.parts).equals(bytes));
        assert(f.calls.some((c) => c.name === 'HeadObjectCommand'));
    } finally {
        await call('neon_storage_upload_abort', {id}, f);
    }
});

test('Storage transfers reject cross-connection access, invalid offsets, oversized files and malformed data', async () => {
    const f = fixture();
    await assert.rejects(
        call('neon_storage_upload_start', {key: 'large', size: STORAGE_MAX_FILE_BYTES + 1}, f),
        /10 GiB/,
    );
    const {id} = await call('neon_storage_upload_start', {key: 'small.bin', size: 1}, f);
    try {
        await assert.rejects(call('neon_storage_upload_abort', {id}, f, 'other'), /unavailable/);
        await assert.rejects(
            call('neon_storage_upload_chunk', {id, offset: 0, data: 'AA=='}, f, 'connection', {
                ...credentials,
                AWS_SECRET_ACCESS_KEY: 'rotated',
            }),
            /unavailable/,
        );
        await assert.rejects(
            call('neon_storage_upload_chunk', {id, offset: 1, data: 'AA=='}, f),
            /offset/,
        );
        await assert.rejects(
            call('neon_storage_upload_chunk', {id, offset: 0, data: '%%%bad'}, f),
            /Invalid/,
        );
    } finally {
        await call('neon_storage_upload_abort', {id}, f);
    }
    assert(f.calls.some((c) => c.name === 'AbortMultipartUploadCommand'));
    assert.equal(f.destroyed(), 1);
});

test('Storage creates empty binary files without multipart state', async () => {
    const f = fixture();
    const {id} = await call('neon_storage_upload_start', {key: 'empty.bin', size: 0}, f);
    await call('neon_storage_upload_complete', {id}, f);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].name, 'PutObjectCommand');
    assert.equal(f.calls[0].input.Body.length, 0);
});

test('Storage abandoned upload leases abort their remote multipart upload', async (t) => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const f = fixture();
    const {id} = await call('neon_storage_upload_start', {key: 'abandoned', size: 1024}, f);
    t.mock.timers.tick(90001);
    await new Promise(setImmediate);
    assert.equal(f.destroyed(), 1);
    assert(f.calls.some((c) => c.name === 'AbortMultipartUploadCommand'));
    await assert.rejects(call('neon_storage_upload_complete', {id}, f), /expired/);
});

test('Storage download uses an attachment URL with a short expiry instead of loading file bytes into RPC', async () => {
    const {url, expiresIn} = await call('neon_storage_download', {
        bucket: 'media',
        key: 'photos/image.png',
    });
    const parsed = new URL(url);
    assert.equal(expiresIn, 60);
    assert.equal(parsed.searchParams.get('X-Amz-Expires'), '60');
    assert.equal(parsed.pathname, '/media/photos/image.png');
    assert(parsed.searchParams.get('response-content-disposition').startsWith('attachment;'));
    assert(!url.includes('dummy-private-key'));
});

test('Storage retries failed multipart cleanup without reopening the closed upload', async (t) => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const f = fixture();
    const {id} = await call('neon_storage_upload_start', {key: 'cleanup.bin', size: 1}, f);
    f.failAbort();
    await assert.rejects(call('neon_storage_upload_abort', {id}, f), /Storage transfer failed/);
    await assert.rejects(call('neon_storage_upload_complete', {id}, f), /no longer active/);
    t.mock.timers.tick(5001);
    await new Promise(setImmediate);
    assert.equal(f.calls.filter((c) => c.name === 'AbortMultipartUploadCommand').length, 2);
    assert.equal(f.destroyed(), 1);
});
