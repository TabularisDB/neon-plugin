import {test} from 'node:test';
import assert from 'node:assert/strict';
import {S3Client} from '@aws-sdk/client-s3';
import {service} from '../dist/services.js';
import {withCredentials} from '../dist/env.js';

const credentials = {
    AWS_ENDPOINT_URL_S3: 'https://example.invalid',
    AWS_REGION: 'test',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
};

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
