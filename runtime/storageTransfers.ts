import {
    S3Client,
    CreateMultipartUploadCommand,
    UploadPartCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    type CompletedPart,
} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {createHash, randomUUID} from 'node:crypto';
import {env} from './env.js';
import {text, type Params} from './database.js';

export const STORAGE_CHUNK_BYTES = 512 * 1024;
export const STORAGE_MAX_FILE_BYTES = 10 * 1024 ** 3;
const partBytes = 5 * 1024 * 1024;
const leaseMs = 90000;
interface Upload {
    owner: string;
    client: S3Client;
    bucket: string;
    key: string;
    contentType: string;
    size: number;
    received: number;
    buffers: Buffer[];
    buffered: number;
    parts: CompletedPart[];
    uploadId?: string;
    last?: {offset: number; digest: string};
    queue: Promise<unknown>;
    timer: ReturnType<typeof setTimeout>;
    abort: AbortController;
    closed: boolean;
    cleanupAttempts?: number;
}
const uploads = new Map<string, Upload>();
const completed = new Map<string, {owner: string; key: string; size: number; expires: number}>();
function transferFailure(): never {
    throw new Error('Storage transfer failed; check service access and retry');
}

export function storageClient(): S3Client {
    return new S3Client({
        endpoint: env('AWS_ENDPOINT_URL_S3'),
        region: env('AWS_REGION'),
        forcePathStyle: true,
        credentials: {
            accessKeyId: env('AWS_ACCESS_KEY_ID'),
            secretAccessKey: env('AWS_SECRET_ACCESS_KEY'),
        },
    });
}

export function storageBucket(value: unknown = 'assets'): string {
    const bucket = text(value, 'bucket');
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Invalid bucket name');
    return bucket;
}

function objectKey(value: unknown): string {
    const key = text(value, 'object key');
    if (Buffer.byteLength(key) > 1024 || key.includes('\0'))
        throw new Error('Object keys must be at most 1024 bytes');
    return key;
}

async function cancel(id: string, upload: Upload): Promise<void> {
    if (upload.closed && uploads.get(id) !== upload) return;
    upload.closed = true;
    uploads.delete(id);
    clearTimeout(upload.timer);
    upload.abort.abort();
    await upload.queue.catch(() => undefined);
    upload.buffers = [];
    upload.buffered = 0;
    try {
        if (upload.uploadId)
            await upload.client
                .send(
                    new AbortMultipartUploadCommand({
                        Bucket: upload.bucket,
                        Key: upload.key,
                        UploadId: upload.uploadId,
                    }),
                    {abortSignal: AbortSignal.timeout(30000)},
                )
                .catch((error: unknown) => {
                    if (
                        error instanceof Error &&
                        ['NoSuchUpload', 'NoSuchBucket'].includes(error.name)
                    )
                        return;
                    transferFailure();
                });
    } catch (error) {
        upload.cleanupAttempts = (upload.cleanupAttempts ?? 0) + 1;
        if (upload.cleanupAttempts < 3) {
            uploads.set(id, upload);
            upload.timer = setTimeout(() => {
                void cancel(id, upload).catch(() => console.error('Neon upload cleanup failed'));
            }, 5000);
            upload.timer.unref();
        } else upload.client.destroy();
        throw error;
    }
    upload.client.destroy();
}

function renew(id: string, upload: Upload): void {
    clearTimeout(upload.timer);
    upload.timer = setTimeout(() => {
        void cancel(id, upload).catch(() => console.error('Neon upload cleanup failed'));
    }, leaseMs);
    upload.timer.unref();
}

async function part(upload: Upload): Promise<void> {
    if (!upload.buffered) return;
    const Body = Buffer.concat(upload.buffers, upload.buffered);
    const PartNumber = upload.parts.length + 1;
    const result = await upload.client
        .send(
            new UploadPartCommand({
                Bucket: upload.bucket,
                Key: upload.key,
                UploadId: upload.uploadId,
                PartNumber,
                Body,
            }),
            {abortSignal: AbortSignal.any([upload.abort.signal, AbortSignal.timeout(30000)])},
        )
        .catch(transferFailure);
    if (!result.ETag) throw new Error('Storage did not acknowledge the uploaded part');
    const completedPart: CompletedPart = {PartNumber, ETag: result.ETag};
    for (const key of [
        'ChecksumCRC32',
        'ChecksumCRC32C',
        'ChecksumSHA1',
        'ChecksumSHA256',
    ] as const)
        if (result[key]) completedPart[key] = result[key];
    upload.parts.push(completedPart);
    upload.buffers = [];
    upload.buffered = 0;
}

/** Chunked RPC uploads keep binary data and large files out of the text preview buffer. */
export async function storageTransfer(
    method: string,
    args: Params,
    connectionId: string,
    connect: () => S3Client = storageClient,
): Promise<unknown> {
    const owner = createHash('sha256')
        .update(
            JSON.stringify([
                connectionId,
                env('AWS_ENDPOINT_URL_S3'),
                env('AWS_ACCESS_KEY_ID'),
                env('AWS_SECRET_ACCESS_KEY'),
            ]),
        )
        .digest('hex');
    for (const [id, receipt] of completed) if (receipt.expires <= Date.now()) completed.delete(id);
    if (method === 'neon_storage_download') {
        const client = connect();
        try {
            const Key = objectKey(args.key);
            const url = await getSignedUrl(
                client,
                new GetObjectCommand({
                    Bucket: storageBucket(args.bucket),
                    Key,
                    ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(Key.split('/').at(-1) || 'download')}`,
                }),
                {expiresIn: 60},
            ).catch(transferFailure);
            return {url, expiresIn: 60};
        } finally {
            client.destroy();
        }
    }
    if (method === 'neon_storage_upload_start') {
        if (
            uploads.size >= 16 ||
            [...uploads.values()].filter((u) => u.owner === owner).length >= 4
        )
            throw new Error('Too many active uploads; finish or cancel an upload first');
        const size = args.size;
        if (
            typeof size !== 'number' ||
            !Number.isSafeInteger(size) ||
            size < 0 ||
            size > STORAGE_MAX_FILE_BYTES
        )
            throw new Error('Files must be at most 10 GiB');
        const contentType = args.contentType || 'application/octet-stream';
        if (
            typeof contentType !== 'string' ||
            contentType.length > 255 ||
            !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(contentType)
        )
            throw new Error('Invalid file content type');
        const bucket = storageBucket(args.bucket),
            key = objectKey(args.key),
            id = randomUUID();
        const client = connect();
        const upload: Upload = {
            owner,
            client,
            bucket,
            key,
            contentType,
            size,
            received: 0,
            buffers: [],
            buffered: 0,
            parts: [],
            queue: Promise.resolve(),
            abort: new AbortController(),
            closed: false,
            timer: setTimeout(() => {}, 0),
        };
        uploads.set(id, upload);
        renew(id, upload);
        try {
            if (size) {
                const result = await client
                    .send(
                        new CreateMultipartUploadCommand({
                            Bucket: bucket,
                            Key: key,
                            ContentType: contentType,
                            Metadata: {'tabularis-upload': id},
                        }),
                        {abortSignal: AbortSignal.timeout(30000)},
                    )
                    .catch(transferFailure);
                if (!result.UploadId) throw new Error('Storage did not start the multipart upload');
                upload.uploadId = result.UploadId;
            }
            return {id, chunkBytes: STORAGE_CHUNK_BYTES, maxBytes: STORAGE_MAX_FILE_BYTES};
        } catch (error) {
            await cancel(id, upload).catch(() => undefined);
            throw error;
        }
    }
    const id = text(args.id, 'upload');
    const receipt = completed.get(id);
    if (receipt?.owner === owner && method === 'neon_storage_upload_complete')
        return {key: receipt.key, size: receipt.size};
    const upload = uploads.get(id);
    if (!upload && method === 'neon_storage_upload_abort') return null;
    if (!upload || upload.owner !== owner) throw new Error('Upload is unavailable or expired');
    if (method === 'neon_storage_upload_abort') {
        await cancel(id, upload);
        return null;
    }
    if (upload.closed) throw new Error('Upload is no longer active');
    if (!['neon_storage_upload_chunk', 'neon_storage_upload_complete'].includes(method))
        throw new Error('Unsupported upload operation');
    renew(id, upload);
    const task = upload.queue
        .catch(() => undefined)
        .then(async () => {
            if (upload.closed) throw new Error('Upload is no longer active');
            if (method === 'neon_storage_upload_chunk') {
                if (
                    typeof args.data !== 'string' ||
                    !args.data ||
                    args.data.length > 4 * Math.ceil(STORAGE_CHUNK_BYTES / 3)
                )
                    throw new Error('Upload chunks must be at most 512 KiB');
                const bytes = Buffer.from(args.data, 'base64');
                if (
                    bytes.toString('base64') !== args.data ||
                    !bytes.length ||
                    bytes.length > STORAGE_CHUNK_BYTES
                )
                    throw new Error('Invalid upload chunk');
                const digest = createHash('sha256').update(bytes).digest('hex');
                if (
                    upload.last &&
                    upload.last.offset === args.offset &&
                    upload.last.digest === digest
                )
                    return {offset: upload.received};
                if (args.offset !== upload.received || upload.received + bytes.length > upload.size)
                    throw new Error('Unexpected upload offset or length');
                const previousBuffers = upload.buffers,
                    previousBytes = upload.buffered;
                upload.buffers = [...previousBuffers, bytes];
                upload.buffered += bytes.length;
                try {
                    if (upload.buffered >= partBytes) await part(upload);
                } catch (error) {
                    upload.buffers = previousBuffers;
                    upload.buffered = previousBytes;
                    throw error;
                }
                upload.last = {offset: upload.received, digest};
                upload.received += bytes.length;
                return {offset: upload.received};
            }
            if (upload.received !== upload.size) throw new Error('The upload is incomplete');
            try {
                if (upload.size) {
                    await part(upload);
                    try {
                        await upload.client.send(
                            new CompleteMultipartUploadCommand({
                                Bucket: upload.bucket,
                                Key: upload.key,
                                UploadId: upload.uploadId,
                                MultipartUpload: {Parts: upload.parts},
                            }),
                            {abortSignal: AbortSignal.timeout(30000)},
                        );
                    } catch (error) {
                        const head = await upload.client
                            .send(new HeadObjectCommand({Bucket: upload.bucket, Key: upload.key}), {
                                abortSignal: AbortSignal.timeout(30000),
                            })
                            .catch(() => null);
                        if (
                            head?.Metadata?.['tabularis-upload'] !== id ||
                            head.ContentLength !== upload.size
                        )
                            transferFailure();
                    }
                } else
                    await upload.client
                        .send(
                            new PutObjectCommand({
                                Bucket: upload.bucket,
                                Key: upload.key,
                                Body: Buffer.alloc(0),
                                ContentType: upload.contentType,
                            }),
                            {abortSignal: AbortSignal.timeout(30000)},
                        )
                        .catch(transferFailure);
                upload.closed = true;
                uploads.delete(id);
                clearTimeout(upload.timer);
                upload.client.destroy();
                if (completed.size >= 64) completed.delete(completed.keys().next().value!);
                completed.set(id, {
                    owner,
                    key: upload.key,
                    size: upload.size,
                    expires: Date.now() + 300000,
                });
                return {key: upload.key, size: upload.size};
            } catch (error) {
                // The queued task cannot await its own cancellation queue.
                queueMicrotask(() => {
                    void cancel(id, upload).catch(() =>
                        console.error('Neon upload cleanup failed'),
                    );
                });
                throw error;
            }
        });
    upload.queue = task;
    return task;
}

process.stdin.once('end', () => {
    for (const [id, upload] of uploads)
        void cancel(id, upload).catch(() => console.error('Neon upload cleanup failed'));
});
