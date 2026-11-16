import {useEffect, useId, useRef, useState} from 'react';
import {usePluginRpc, usePluginTranslation} from '@tabularis/plugin-api';
import {PanelSection} from './PanelSection';

function readChunk(blob: Blob, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const reader = new FileReader();
        const abort = () => reader.abort();
        const cleanup = () => signal.removeEventListener('abort', abort);
        reader.onload = () => {
            cleanup();
            resolve(String(reader.result).split(',')[1]);
        };
        reader.onerror = () => {
            cleanup();
            reject(new Error('File read failed'));
        };
        reader.onabort = () => {
            cleanup();
            reject(new DOMException('File read cancelled', 'AbortError'));
        };
        signal.addEventListener('abort', abort, {once: true});
        reader.readAsDataURL(blob);
    });
}

export function StorageFileTransfer({
    connectionId,
    bucket,
    prefix,
    onUploaded,
}: {
    connectionId: string;
    bucket: string;
    prefix: string;
    onUploaded: () => void;
}) {
    const {call} = usePluginRpc('neon', connectionId);
    const t = usePluginTranslation('neon');
    const id = useId();
    const [file, setFile] = useState<File>();
    const [key, setKey] = useState('');
    const [confirm, setConfirm] = useState(false);
    const [phase, setPhase] = useState<'uploading' | 'committing'>();
    const [progress, setProgress] = useState(0);
    const [message, setMessage] = useState<string>();
    const [error, setError] = useState<string>();
    const controller = useRef<AbortController | undefined>(undefined);
    const mounted = useRef(true);
    const serverId = useRef<string | undefined>(undefined);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            controller.current?.abort();
            if (serverId.current)
                void call('neon_storage_upload_abort', {id: serverId.current}).catch(
                    () => undefined,
                );
        };
    }, [call]);
    const upload = async () => {
        if (!file || !bucket || !key.trim() || phase) return;
        const abort = new AbortController();
        controller.current = abort;
        setConfirm(false);
        setPhase('uploading');
        setProgress(0);
        setMessage(undefined);
        setError(undefined);
        let uploadId: string | undefined,
            completed = false;
        try {
            const started = await call<{id: string; chunkBytes: number}>(
                'neon_storage_upload_start',
                {
                    bucket,
                    key,
                    size: file.size,
                    contentType: file.type.split(';', 1)[0] || 'application/octet-stream',
                },
            );
            uploadId = started.id;
            serverId.current = uploadId;
            if (
                !Number.isSafeInteger(started.chunkBytes) ||
                started.chunkBytes < 1 ||
                started.chunkBytes > 512 * 1024
            )
                throw new Error('Invalid upload chunk size');
            for (let offset = 0; offset < file.size;) {
                abort.signal.throwIfAborted();
                const end = Math.min(offset + started.chunkBytes, file.size);
                const data = await readChunk(file.slice(offset, end), abort.signal);
                const result = await call<{offset: number}>('neon_storage_upload_chunk', {
                    id: uploadId,
                    offset,
                    data,
                });
                if (result.offset !== end)
                    throw new Error('Storage returned an invalid upload offset');
                offset = end;
                if (!abort.signal.aborted) setProgress(offset);
            }
            abort.signal.throwIfAborted();
            setPhase('committing');
            await call('neon_storage_upload_complete', {id: uploadId});
            completed = true;
            if (!abort.signal.aborted) {
                setMessage(t('files.uploaded'));
                onUploaded();
            }
        } catch (cause) {
            if (!mounted.current) return;
            if (abort.signal.aborted) setMessage(t('files.cancelled'));
            else setError(cause instanceof Error ? cause.message : t('files.failed'));
        } finally {
            if (uploadId && !completed)
                await call('neon_storage_upload_abort', {id: uploadId}).catch(() => undefined);
            if (controller.current === abort) {
                serverId.current = undefined;
                controller.current = undefined;
                if (mounted.current) setPhase(undefined);
            }
        }
    };
    return (
        <PanelSection title={t('files.title')} hint={t('files.hint')}>
            <label className="neon-field-label" htmlFor={`${id}-file`}>
                {t('files.file')}
            </label>
            <input
                id={`${id}-file`}
                className="neon-field"
                type="file"
                disabled={!!phase}
                onChange={(event) => {
                    const chosen = event.target.files?.[0];
                    setFile(chosen);
                    setConfirm(false);
                    setMessage(undefined);
                    setError(undefined);
                    setKey(
                        chosen
                            ? `${prefix}${prefix && !prefix.endsWith('/') ? '/' : ''}${chosen.name}`
                            : '',
                    );
                }}
            />
            <label className="neon-field-label" htmlFor={`${id}-key`}>
                {t('files.destination')}
            </label>
            <input
                id={`${id}-key`}
                className="neon-field"
                value={key}
                disabled={!!phase}
                onChange={(event) => {
                    setKey(event.target.value);
                    setConfirm(false);
                }}
            />
            <div className="neon-actionbar">
                <button
                    type="button"
                    className="neon-button neon-button-primary"
                    disabled={
                        !file || !key.trim() || !bucket || !!phase || file.size > 10 * 1024 ** 3
                    }
                    onClick={() => setConfirm(true)}
                >
                    {t('files.upload')}
                </button>
                {phase && (
                    <button
                        type="button"
                        className="neon-button"
                        disabled={phase === 'committing'}
                        onClick={() => {
                            controller.current?.abort();
                            if (serverId.current)
                                void call('neon_storage_upload_abort', {
                                    id: serverId.current,
                                }).catch(() => undefined);
                        }}
                    >
                        {t('files.cancel')}
                    </button>
                )}
            </div>
            {file && file.size > 10 * 1024 ** 3 && (
                <p role="alert" className="neon-error">
                    {t('files.tooLarge')}
                </p>
            )}
            {confirm && (
                <div className="neon-confirmation">
                    <p>{t('files.confirm', {file: file?.name, bucket, key})}</p>
                    <button
                        className="neon-button neon-button-primary"
                        onClick={() => void upload()}
                    >
                        {t('files.confirmUpload')}
                    </button>
                    <button className="neon-button" onClick={() => setConfirm(false)}>
                        {t('files.cancel')}
                    </button>
                </div>
            )}
            {phase && (
                <div role="status">
                    <progress
                        aria-label={t('files.progress')}
                        max={file?.size || 1}
                        value={progress}
                    />
                    <p className="neon-hint">
                        {phase === 'committing'
                            ? t('files.committing')
                            : t('files.progressBytes', {sent: progress, total: file?.size ?? 0})}
                    </p>
                </div>
            )}
            {message && (
                <p role="status" className="neon-hint">
                    {message}
                </p>
            )}
            {error && (
                <p role="alert" className="neon-error">
                    {error}
                </p>
            )}
        </PanelSection>
    );
}
