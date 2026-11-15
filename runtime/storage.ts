import type {GetObjectCommandOutput} from '@aws-sdk/client-s3';

export const MAX_STORAGE_TEXT_BYTES = 1024 * 1024;

export async function readStorageText(
    object: GetObjectCommandOutput,
    signal: AbortSignal,
): Promise<string> {
    const reader = object.Body?.transformToWebStream().getReader();
    const cancel = () => {
        void reader?.cancel(signal.reason).catch(() => {});
    };
    let complete = false;
    try {
        signal.throwIfAborted();
        if (object.ContentLength !== undefined && object.ContentLength > MAX_STORAGE_TEXT_BYTES)
            throw new Error('Storage text reads are limited to 1 MiB');
        const mime = object.ContentType?.split(';', 1)[0].trim().toLowerCase();
        const charset = object.ContentType?.match(
            /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i,
        )?.[1].toLowerCase();
        if (
            !mime ||
            !(
                mime.startsWith('text/') ||
                /^application\/(?:json|xml|javascript|[\w.+-]+\+(?:json|xml))$/.test(mime)
            ) ||
            (charset !== undefined && charset !== 'utf-8' && charset !== 'utf8')
        )
            throw new Error('Storage reads support UTF-8 text objects only');
        if (!reader) return '';
        signal.addEventListener('abort', cancel, {once: true});
        const decoder = new TextDecoder('utf-8', {fatal: true});
        const parts: string[] = [];
        let bytes = 0;
        while (true) {
            const {done, value} = await reader.read();
            signal.throwIfAborted();
            if (done) {
                parts.push(decoder.decode());
                complete = true;
                return parts.join('');
            }
            bytes += value.byteLength;
            if (bytes > MAX_STORAGE_TEXT_BYTES)
                throw new Error('Storage text reads are limited to 1 MiB');
            const part = decoder.decode(value, {stream: true});
            if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(part))
                throw new Error('Storage reads support UTF-8 text objects only');
            parts.push(part);
        }
    } finally {
        signal.removeEventListener('abort', cancel);
        if (!complete) await reader?.cancel().catch(() => {});
        reader?.releaseLock();
    }
}
