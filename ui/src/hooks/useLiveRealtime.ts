import {useCallback, useEffect, useRef, useState} from 'react';
import {usePluginRpc} from '@tabularis/plugin-api';

interface Snapshot {
    id: string;
    revision: number;
    status: 'connecting' | 'live' | 'stale' | 'closed' | 'error';
    rows?: Record<string, unknown>[];
    error?: string;
    updatedAt?: string;
}

export function useLiveRealtime(connectionId: string) {
    const {call} = usePluginRpc('neon', connectionId);
    const [result, setResult] = useState<Snapshot>();
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string>();
    const active = useRef<string | undefined>(undefined);
    const epoch = useRef(0);
    const stop = useCallback(() => {
        epoch.current++;
        const id = active.current;
        active.current = undefined;
        setPending(false);
        setResult((value) => (value ? {...value, status: 'closed'} : value));
        if (id) void call('neon_realtime_stop', {id}).catch(() => undefined);
    }, [call]);
    const start = useCallback(
        async (query: string) => {
            stop();
            const generation = epoch.current;
            setResult(undefined);
            setError(undefined);
            setPending(true);
            try {
                const response = await call<Snapshot>('neon_realtime_start', {query});
                if (generation !== epoch.current) {
                    void call('neon_realtime_stop', {id: response.id}).catch(() => undefined);
                    return;
                }
                active.current = response.id;
                setResult(response);
                if (response.status === 'error') {
                    active.current = undefined;
                    setError(response.error);
                    void call('neon_realtime_stop', {id: response.id}).catch(() => undefined);
                }
            } catch (cause) {
                if (generation === epoch.current)
                    setError(cause instanceof Error ? cause.message : 'Realtime start failed');
            } finally {
                if (generation === epoch.current) setPending(false);
            }
        },
        [call, stop],
    );
    useEffect(
        () => () => {
            epoch.current++;
            const id = active.current;
            active.current = undefined;
            if (id) void call('neon_realtime_stop', {id}).catch(() => undefined);
        },
        [call],
    );
    useEffect(() => {
        if (!result || ['error', 'closed'].includes(result.status) || active.current !== result.id)
            return;
        const id = result.id,
            generation = epoch.current;
        let revision = result.revision,
            disposed = false;
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try {
                const response = await call<Partial<Snapshot>>('neon_realtime_poll', {
                    id,
                    revision,
                });
                if (disposed || generation !== epoch.current || active.current !== id) return;
                revision = response.revision ?? revision;
                setResult((value) => (value?.id === id ? {...value, ...response} : value));
                if (response.status === 'error') {
                    active.current = undefined;
                    setError(response.error);
                    void call('neon_realtime_stop', {id}).catch(() => undefined);
                    return;
                }
                timer = setTimeout(poll, 1000);
            } catch (cause) {
                if (disposed || generation !== epoch.current) return;
                active.current = undefined;
                setError(cause instanceof Error ? cause.message : 'Realtime connection failed');
                setResult((value) => (value?.id === id ? {...value, status: 'error'} : value));
                void call('neon_realtime_stop', {id}).catch(() => undefined);
            }
        };
        timer = setTimeout(poll, 1000);
        return () => {
            disposed = true;
            clearTimeout(timer);
        };
    }, [call, result]);
    return {
        result,
        pending,
        error,
        start,
        stop,
        active: !!result && ['connecting', 'live', 'stale'].includes(result.status),
        reset: () => {
            stop();
            setResult(undefined);
            setError(undefined);
        },
    };
}
