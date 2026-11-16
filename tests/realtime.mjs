import {test} from 'node:test';
import assert from 'node:assert/strict';
import {realtimeSession} from '../dist/realtime.js';
import {withCredentials} from '../dist/env.js';

const credentials = {
    NEON_REALTIME_URL: 'https://realtime.example.invalid',
    NEON_REALTIME_SECRET: 'private-realtime-secret',
    DATABASE_URL: 'postgresql://user:private-password@db.example.invalid/neondb',
};
function fixture() {
    let snapshot = {status: 'connecting', data: undefined};
    let listener;
    let closed = 0,
        unsubscribed = 0,
        subscriptions = 0;
    const client = {
        subscribe: async () => {
            subscriptions++;
            return {
                getSnapshot: () => snapshot,
                onChange: (fn) => {
                    listener = fn;
                    return () => {
                        listener = undefined;
                    };
                },
                unsubscribe: () => {
                    unsubscribed++;
                },
            };
        },
        close: () => {
            closed++;
        },
    };
    return {
        connect: () => client,
        update(data, status = 'live') {
            snapshot = {status, data};
            listener?.();
        },
        counts: () => ({closed, unsubscribed, subscriptions}),
    };
}
const call = (method, args, f, owner = 'connection', secrets = credentials) =>
    withCredentials(secrets, () => realtimeSession(method, args, owner, f.connect));

test('Realtime keeps one server subscription alive across polls, delivers changes and closes explicitly', async () => {
    const f = fixture();
    const started = await call('neon_realtime_start', {query: 'SELECT 1'}, f);
    try {
        assert.equal(started.status, 'connecting');
        f.update([{value: 1n}]);
        const first = await call(
            'neon_realtime_poll',
            {id: started.id, revision: started.revision},
            f,
        );

        test('Realtime startup never exposes a signing secret from SDK errors', async () => {
            const f = fixture();
            f.connect = () => {
                throw new Error(credentials.NEON_REALTIME_SECRET);
            };
            await assert.rejects(
                call('neon_realtime_start', {query: 'SELECT 1'}, f),
                (error) => !error.message.includes('private-') && /credentials/.test(error.message),
            );
        });
        assert.deepEqual(first.rows, [{value: '1'}]);
        assert.equal(first.status, 'live');
        assert(!JSON.stringify(first).includes('private-'));
        const unchanged = await call(
            'neon_realtime_poll',
            {id: started.id, revision: first.revision},
            f,
        );
        assert.equal(unchanged.rows, undefined);
        f.update([{value: 2}]);
        assert.deepEqual(
            (await call('neon_realtime_poll', {id: started.id, revision: first.revision}, f)).rows,
            [{value: 2}],
        );
        assert.equal(f.counts().subscriptions, 1);
    } finally {
        await call('neon_realtime_stop', {id: started.id}, f);
    }
    assert.deepEqual(f.counts(), {closed: 1, unsubscribed: 1, subscriptions: 1});
    await assert.rejects(call('neon_realtime_poll', {id: started.id}, f), /unavailable/);
});

test('Realtime sessions never cross connections or rotated credentials', async () => {
    const f = fixture();
    const {id} = await call('neon_realtime_start', {query: 'SELECT 1'}, f);
    try {
        await assert.rejects(call('neon_realtime_poll', {id}, f, 'other'), /unavailable/);
        await assert.rejects(
            call('neon_realtime_stop', {id}, f, 'connection', {
                ...credentials,
                NEON_REALTIME_SECRET: 'other',
            }),
            /unavailable/,
        );
        assert.equal(f.counts().closed, 0);
    } finally {
        await call('neon_realtime_stop', {id}, f);
    }
});

test('Realtime closes oversized results instead of silently truncating them', async () => {
    for (const rows of [
        Array.from({length: 1001}, () => ({value: 1})),
        [{value: 'x'.repeat(1024 * 1024)}],
    ]) {
        const f = fixture();
        const {id} = await call('neon_realtime_start', {query: 'SELECT 1'}, f);
        f.update(rows);
        const result = await call('neon_realtime_poll', {id}, f);
        assert.equal(result.status, 'error');
        assert.match(result.error, /exceed/);
        assert.equal(result.rows, undefined);
        assert.equal(f.counts().closed, 1);
        await call('neon_realtime_stop', {id}, f);
    }
});

test('Realtime abandoned leases expire and close their socket', async (t) => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const f = fixture();
    const {id} = await call('neon_realtime_start', {query: 'SELECT 1'}, f);
    t.mock.timers.tick(60001);
    await assert.rejects(call('neon_realtime_poll', {id}, f), /expired/);
    assert.equal(f.counts().closed, 1);
});

test('Realtime refuses write statements and bounds active subscriptions per connection', async () => {
    const f = fixture();
    await assert.rejects(call('neon_realtime_start', {query: 'DELETE FROM users'}, f), /SELECT/);
    const ids = [];
    try {
        for (let i = 0; i < 4; i++)
            ids.push((await call('neon_realtime_start', {query: 'SELECT 1'}, f)).id);
        await assert.rejects(
            call('neon_realtime_start', {query: 'SELECT 1'}, f),
            /Stop an existing/,
        );
    } finally {
        for (const id of ids) await call('neon_realtime_stop', {id}, f);
    }
});
