import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {S3Client} from '@aws-sdk/client-s3';
import {service} from '../dist/services.js';
import {withCredentials} from '../dist/env.js';
import {MAX_STORAGE_TEXT_BYTES, readStorageText} from '../dist/storage.js';

const credentials = {
    AWS_ENDPOINT_URL_S3: 'https://example.invalid',
    AWS_REGION: 'test',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
};

function storedText(chunks, metadata = {}) {
    let reads = 0;
    let cancelled = false;
    const stream = new ReadableStream(
        {
            pull(controller) {
                const chunk = chunks[reads++];
                if (chunk === undefined) controller.close();
                else controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            },
            cancel() {
                cancelled = true;
            },
        },
        {highWaterMark: 0},
    );
    return {
        object: {
            ContentType: 'text/plain',
            ...metadata,
            Body: {transformToWebStream: () => stream},
        },
        reads: () => reads,
        cancelled: () => cancelled,
        stream,
    };
}

test('Storage reads complete UTF-8 text within the byte limit, including split characters and empty objects', async () => {
    const unicode = Buffer.from('a😀z');
    for (const ContentType of [
        'text/plain; charset="UTF-8"',
        'application/json',
        'application/ld+json',
    ]) {
        const {object, cancelled, stream} = storedText(
            [unicode.subarray(0, 3), unicode.subarray(3)],
            {
                ContentType,
            },
        );
        assert.equal(await readStorageText(object, new AbortController().signal), 'a😀z');
        assert.equal(cancelled(), false);
        assert.equal(stream.locked, false);
    }
    assert.equal(
        (
            await readStorageText(
                storedText(['x'.repeat(MAX_STORAGE_TEXT_BYTES)]).object,
                new AbortController().signal,
            )
        ).length,
        MAX_STORAGE_TEXT_BYTES,
    );
    assert.equal(await readStorageText(storedText([]).object, new AbortController().signal), '');
});

test('Storage rejects advertised oversize and unsupported MIME types without consuming their bodies', async () => {
    for (const metadata of [
        {ContentLength: MAX_STORAGE_TEXT_BYTES + 1},
        {ContentType: 'application/octet-stream'},
        {ContentType: 'image/png'},
        {ContentType: undefined},
        {ContentType: 'text/plain; charset=iso-8859-1'},
    ]) {
        const {object, reads, cancelled, stream} = storedText(['not consumed'], metadata);
        await assert.rejects(
            readStorageText(object, new AbortController().signal),
            /1 MiB|UTF-8 text/,
        );
        assert.equal(reads(), 0);
        assert.equal(cancelled(), true);
        assert.equal(stream.locked, false);
    }
});

test('Storage bounds actual bytes with missing or dishonest ContentLength and cancels immediately', async () => {
    for (const metadata of [{}, {ContentLength: 1}]) {
        const {object, reads, cancelled, stream} = storedText(
            ['x'.repeat(MAX_STORAGE_TEXT_BYTES), 'overflow', 'must not be consumed'],
            metadata,
        );
        await assert.rejects(readStorageText(object, new AbortController().signal), /1 MiB/);
        assert.equal(reads(), 2);
        assert.equal(cancelled(), true);
        assert.equal(stream.locked, false);
    }
    const multibyte = storedText(['😀'.repeat(MAX_STORAGE_TEXT_BYTES / 4), '😀']);
    await assert.rejects(readStorageText(multibyte.object, new AbortController().signal), /1 MiB/);
});

test('Storage rejects binary or invalid UTF-8 content even with a text MIME type and releases the stream', async () => {
    for (const chunk of [Buffer.from([0xff]), Buffer.from([0xe2]), 'text\0binary']) {
        const {object, cancelled, stream} = storedText([chunk, 'unread']);
        await assert.rejects(readStorageText(object, new AbortController().signal));
        assert.equal(cancelled(), true);
        assert.equal(stream.locked, false);
    }
});

test('Storage abort cancels a blocked body read and preserves the abort reason', async () => {
    const abort = new AbortController();
    let cancelled = false;
    let started;
    const reading = new Promise((resolve) => {
        started = resolve;
    });
    const stream = new ReadableStream(
        {
            pull() {
                started();
            },
            cancel() {
                cancelled = true;
            },
        },
        {highWaterMark: 0},
    );
    const result = readStorageText(
        {ContentType: 'text/plain', Body: {transformToWebStream: () => stream}},
        abort.signal,
    );
    await reading;
    const reason = new Error('test cancelled');
    abort.abort(reason);
    await assert.rejects(result, (error) => error === reason);
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
});

test('Storage cancels Node response bodies through the SDK Web stream adapter', async () => {
    const body = Readable.from([Buffer.from('hello'), Buffer.alloc(MAX_STORAGE_TEXT_BYTES)]);
    await assert.rejects(
        readStorageText(
            {ContentType: 'text/plain', Body: {transformToWebStream: () => Readable.toWeb(body)}},
            new AbortController().signal,
        ),
        /1 MiB/,
    );
    assert.equal(body.destroyed, true);
});

test('Storage get applies the bounded reader and destroys the S3 client after rejection', async () => {
    const originalSend = S3Client.prototype.send;
    const originalDestroy = S3Client.prototype.destroy;
    const {object, reads, cancelled} = storedText(['unread'], {
        ContentLength: MAX_STORAGE_TEXT_BYTES + 1,
    });
    let destroyed = false;
    S3Client.prototype.send = async () => object;
    S3Client.prototype.destroy = () => {
        destroyed = true;
    };
    try {
        await assert.rejects(
            withCredentials(credentials, () => service('neon_storage_get', {key: 'large.txt'})),
            /1 MiB/,
        );
        assert.equal(reads(), 0);
        assert.equal(cancelled(), true);
        assert.equal(destroyed, true);
    } finally {
        S3Client.prototype.send = originalSend;
        S3Client.prototype.destroy = originalDestroy;
    }
});

test('Storage returns bounded pages and carries continuation tokens through the next request', async () => {
    const original = S3Client.prototype.send;
    const calls = [];
    S3Client.prototype.send = async function (command) {
        calls.push(command.input);
        return calls.length === 1
            ? {
                  Contents: [{Key: 'first.txt'}],
                  IsTruncated: true,
                  NextContinuationToken: 'page-two',
              }
            : {Contents: [{Key: 'last.txt'}], IsTruncated: false};
    };
    try {
        const first = await withCredentials(credentials, () =>
            service('neon_storage_list', {prefix: 'folder/'}),
        );
        assert.deepEqual(first, {
            objects: [{Key: 'first.txt'}],
            nextContinuationToken: 'page-two',
        });
        const second = await withCredentials(credentials, () =>
            service('neon_storage_list', {
                prefix: 'folder/',
                continuationToken: first.nextContinuationToken,
            }),
        );
        assert.deepEqual(second, {
            objects: [{Key: 'last.txt'}],
            nextContinuationToken: null,
        });
        assert.deepEqual(calls, [
            {
                Bucket: 'assets',
                Prefix: 'folder/',
                ContinuationToken: undefined,
                MaxKeys: 200,
            },
            {
                Bucket: 'assets',
                Prefix: 'folder/',
                ContinuationToken: 'page-two',
                MaxKeys: 200,
            },
        ]);
    } finally {
        S3Client.prototype.send = original;
    }
});

test('Storage rejects invalid inputs and missing or repeated continuation tokens', async () => {
    const original = S3Client.prototype.send;
    let calls = 0;
    let response = {IsTruncated: true};
    S3Client.prototype.send = async () => {
        calls++;
        return response;
    };
    try {
        for (const args of [
            {prefix: 123},
            {prefix: 'x'.repeat(1025)},
            {continuationToken: ''},
            {continuationToken: 1},
            {continuationToken: 'x'.repeat(8193)},
        ])
            await assert.rejects(
                withCredentials(credentials, () => service('neon_storage_list', args)),
                /prefix|continuation/,
            );
        assert.equal(calls, 0);
        await assert.rejects(
            withCredentials(credentials, () => service('neon_storage_list', {})),
            /invalid continuation/,
        );
        response = {IsTruncated: true, NextContinuationToken: 'same'};
        await assert.rejects(
            withCredentials(credentials, () =>
                service('neon_storage_list', {continuationToken: 'same'}),
            ),
            /invalid continuation/,
        );
        response = {};
        assert.deepEqual(
            await withCredentials(credentials, () => service('neon_storage_list', {})),
            {objects: [], nextContinuationToken: null},
        );
    } finally {
        S3Client.prototype.send = original;
    }
});
