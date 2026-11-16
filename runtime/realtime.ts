import {createHash, randomUUID} from 'node:crypto';
import {
    createRealtime,
    rawSql,
    type RealtimeDirectServer,
    type RealtimeDirectServerOptions,
    type RawSqlQuery,
} from '@neon/realtime/server';
import {env} from './env.js';
import {text, type Params} from './database.js';

const leaseMs = 60000;
const maxRows = 1000;
const maxBytes = 1024 * 1024;
type Client = RealtimeDirectServer<RawSqlQuery<unknown>>;
type Subscription = Awaited<ReturnType<Client['subscribe']>>;
interface Session {
    owner: string;
    client: Client;
    subscription?: Subscription;
    detach?: () => void;
    timer: ReturnType<typeof setTimeout>;
    revision: number;
    released: boolean;
    snapshot: {status: string; rows?: unknown[]; error?: string; updatedAt: string};
}
const sessions = new Map<string, Session>();

function release(session: Session): void {
    if (session.released) return;
    session.released = true;
    session.detach?.();
    session.subscription?.unsubscribe();
    session.client.close();
}

function close(id: string): void {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    clearTimeout(session.timer);
    release(session);
}

/** The browser receives rows, never the Realtime signing secret or sealed query. */
export async function realtimeSession(
    method: string,
    args: Params,
    connectionId: string,
    connect: (
        options: RealtimeDirectServerOptions<RawSqlQuery<unknown>>,
    ) => Client = createRealtime,
): Promise<unknown> {
    const url = env('NEON_REALTIME_URL');
    const secret = env('NEON_REALTIME_SECRET');
    const database = env('DATABASE_URL');
    const owner = createHash('sha256')
        .update(JSON.stringify([connectionId, url, secret, database]))
        .digest('hex');
    if (method === 'neon_realtime_start') {
        if (
            sessions.size >= 32 ||
            [...sessions.values()].filter((s) => s.owner === owner).length >= 4
        )
            throw new Error('Stop an existing Realtime subscription before starting another');
        const query = text(args.query, 'query').trim().replace(/;\s*$/, '');
        if (query.length > 20000 || !/^(select|with)\b/i.test(query))
            throw new Error('Provide a SELECT query of at most 20000 characters');
        const id = randomUUID();
        let client: Client;
        try {
            client = connect({
                url,
                secret,
                db: decodeURIComponent(new URL(database).pathname.slice(1)),
            });
        } catch {
            throw new Error('Realtime credentials are invalid or the service is unavailable');
        }
        const session: Session = {
            owner,
            client,
            revision: 0,
            released: false,
            timer: setTimeout(() => close(id), leaseMs),
            snapshot: {status: 'connecting', updatedAt: new Date().toISOString()},
        };
        session.timer.unref();
        sessions.set(id, session);
        try {
            // Bound the server result before the SDK materializes it locally.
            const subscription = await client.subscribe(
                rawSql(`SELECT * FROM (\n${query}\n) AS tabularis_live LIMIT ${maxRows + 1}`),
            );
            if (!sessions.has(id)) {
                subscription.unsubscribe();
                throw new Error('Realtime subscription expired');
            }
            session.subscription = subscription;
            const update = () => {
                if (!sessions.has(id)) return;
                const snapshot = subscription.getSnapshot();
                try {
                    if (snapshot.status === 'error')
                        throw new Error(
                            'Realtime subscription failed; check the query and service access',
                        );
                    if (snapshot.data && snapshot.data.length > maxRows)
                        throw new Error('Realtime results exceed 1000 rows; narrow the query');
                    const encoded = JSON.stringify(snapshot.data, (_, value: unknown) =>
                        typeof value === 'bigint' ? value.toString() : value,
                    );
                    if (encoded && Buffer.byteLength(encoded) > maxBytes)
                        throw new Error('Realtime results exceed 1 MiB; narrow the query');
                    session.snapshot = {
                        status: snapshot.status,
                        ...(encoded ? {rows: JSON.parse(encoded) as unknown[]} : {}),
                        updatedAt: new Date().toISOString(),
                    };
                } catch (error) {
                    session.snapshot = {
                        status: 'error',
                        error:
                            error instanceof Error ? error.message : 'Realtime subscription failed',
                        updatedAt: new Date().toISOString(),
                    };
                    release(session);
                }
                session.revision++;
            };
            session.detach = subscription.onChange(update);
            update();
            return {id, revision: session.revision, ...session.snapshot};
        } catch {
            close(id);
            throw new Error(
                'Realtime subscription could not start; check the query and service access',
            );
        }
    }
    const id = text(args.id, 'subscription');
    const session = sessions.get(id);
    if (!session || session.owner !== owner)
        throw new Error('Realtime subscription is unavailable or expired');
    if (method === 'neon_realtime_stop') {
        close(id);
        return null;
    }
    if (method !== 'neon_realtime_poll') throw new Error('Unsupported Realtime operation');
    clearTimeout(session.timer);
    session.timer = setTimeout(() => close(id), leaseMs);
    session.timer.unref();
    return {
        id,
        revision: session.revision,
        ...(args.revision === session.revision ? {} : session.snapshot),
    };
}

process.stdin.once('end', () => {
    for (const id of sessions.keys()) close(id);
});
