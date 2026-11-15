import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {executeSql, MAX_QUERY_ROWS, MAX_RESULT_BYTES} from '../dist/sqlPagination.js';

const columns = [{name: 'n', dataTypeID: 23}];
const integerRows = (count) => Array.from({length: count}, (_, i) => [i + 1]);
class FakeClient {
    constructor({rows = integerRows(5), cursor = true, results, fetchError} = {}) {
        this.rows = rows;
        this.cursor = cursor;
        this.results = results;
        this.fetchError = fetchError;
        this.position = 0;
        this.calls = [];
        this.internalRows = 0;
    }
    query(input) {
        const text = typeof input === 'string' ? input : input.text;
        this.calls.push({text, named: !!input.name});
        if (text.startsWith('DECLARE')) {
            assert(
                input.name,
                'DECLARE must use extended Parse to reject SQL batches before execution',
            );
            if (!this.cursor)
                return Promise.reject(
                    Object.assign(new Error('Cannot declare this SQL'), {
                        code: '42601',
                    }),
                );
            this.position = 0;
            return Promise.resolve({rows: [], rowCount: 0});
        }
        if (text.startsWith('MOVE')) {
            const count = Number(text.match(/MOVE FORWARD (\d+)/)[1]);
            this.position = Math.min(count, this.rows.length);
            return Promise.resolve({rows: [], rowCount: this.position});
        }
        if (!(input instanceof pg.Query)) return Promise.resolve({rows: [], rowCount: 0});
        queueMicrotask(() => {
            if (text.startsWith('FETCH') && this.fetchError) {
                input.handleError(new Error('Fetch failed'));
                return;
            }
            let results = this.results;
            if (text.startsWith('FETCH')) {
                const count = Number(text.match(/FETCH FORWARD (\d+)/)[1]);
                const rows = this.rows.slice(this.position, this.position + count);
                this.position += rows.length;
                results = [{rows, command: 'FETCH', fields: columns}];
            }
            for (const result of results ?? [
                {rows: this.rows, command: 'SELECT', fields: columns},
            ]) {
                if (result.fields.length) input.handleRowDescription({fields: result.fields});
                for (const row of result.rows)
                    input.handleDataRow({
                        fields: row.map((value) =>
                            value === null ? null : Buffer.from(String(value)),
                        ),
                    });
                input.handleCommandComplete(
                    {
                        text: `${result.command} ${result.affected ?? result.rows.length}`,
                    },
                    {},
                );
                this.internalRows += input._result.rows.length;
            }
            input.handleReadyForQuery();
        });
        return input;
    }
}

test('cursor pages skip on the server and transfer only one page plus a probe', async () => {
    const client = new FakeClient();
    const result = await executeSql(client, 'SELECT n FROM large_table', 2, 2);
    assert.deepEqual(result.rows, [[3], [4]]);
    assert.deepEqual(result.pagination, {
        page: 2,
        page_size: 2,
        total_rows: null,
        has_more: true,
    });
    assert.equal(result.truncated, true);
    assert.equal(result.affected_rows, 0);
    assert(client.calls.some((call) => call.text === 'MOVE FORWARD 2 FROM "tabularis_page"'));
    assert(client.calls.some((call) => call.text === 'FETCH FORWARD 3 FROM "tabularis_page"'));
    assert.equal(client.internalRows, 0);
    assert.deepEqual(
        client.calls.slice(-2).map((call) => call.text),
        ['CLOSE "tabularis_page"', 'COMMIT'],
    );
});

test('exact, final and empty cursor pages have no extra rows', async () => {
    for (const [count, page, expected] of [
        [4, 2, [[3], [4]]],
        [5, 3, [[5]]],
        [5, 4, []],
    ]) {
        const result = await executeSql(
            new FakeClient({rows: integerRows(count)}),
            'SELECT n FROM t',
            2,
            page,
        );
        assert.deepEqual(result.rows, expected);
        assert.equal(result.pagination.has_more, false);
        assert.equal(result.truncated, false);
        assert.deepEqual(result.columns, ['n']);
    }
});

test('unpaged cursor output is capped and marks omitted rows explicitly', async () => {
    const client = new FakeClient({rows: integerRows(MAX_QUERY_ROWS + 10)});
    const result = await executeSql(client, 'SELECT n FROM t', null, 1);
    assert.equal(result.rows.length, MAX_QUERY_ROWS);
    assert.equal(result.truncated, true);
    assert.equal(result.pagination, null);
    assert.equal(client.position, MAX_QUERY_ROWS + 1);
    assert.equal(client.internalRows, 0);
});

test('invalid sizes, pages and unsafe offsets fail before SQL execution', async () => {
    for (const [limit, page] of [
        [0, 1],
        [-1, 1],
        [MAX_QUERY_ROWS + 1, 1],
        ['10', 1],
        [1, 0],
        [1, null],
        [1, 1.5],
        [2, Number.MAX_SAFE_INTEGER],
    ]) {
        const client = new FakeClient();
        await assert.rejects(executeSql(client, 'SELECT n', limit, page), /page/i);
        assert.deepEqual(client.calls, []);
    }
});

test('failed DECLARE rolls back and executes original batches once with independent result pages', async () => {
    const text = 'UPDATE t SET n=n+1 RETURNING n; SELECT n FROM t';
    const client = new FakeClient({
        cursor: false,
        results: [
            {command: 'UPDATE', affected: 5, rows: integerRows(5), fields: columns},
            {command: 'SELECT', rows: integerRows(3), fields: columns},
        ],
    });
    const result = await executeSql(client, text, 2, 2);
    assert.equal(client.calls.filter((call) => call.text === text).length, 1);
    assert.equal(client.calls[2].text, 'ROLLBACK');
    assert.equal(result.affected_rows, 5);
    assert.deepEqual(result.rows, [[3], [4]]);
    assert.equal(result.pagination.total_rows, 5);
    assert.deepEqual(result.additional_results[0].rows, [[3]]);
    assert.equal(result.additional_results[0].pagination.has_more, false);
    assert.equal(client.internalRows, 0);
});

test('batch collector retains at most 10000 rows while draining all result sets', async () => {
    const client = new FakeClient({
        cursor: false,
        results: [
            {command: 'SELECT', rows: integerRows(100000), fields: columns},
            {command: 'UPDATE', affected: 7, rows: [], fields: []},
            {command: 'SELECT', rows: integerRows(2), fields: columns},
        ],
    });
    const result = await executeSql(client, 'SELECT n FROM t; UPDATE t SET n=0; SELECT 1', null, 1);
    assert.equal(result.rows.length, MAX_QUERY_ROWS);
    assert.equal(result.truncated, true);
    assert.equal(result.additional_results[0].affected_rows, 7);
    assert.equal(result.additional_results[0].pagination, null);
    assert.deepEqual(result.additional_results[1].rows, []);
    assert.equal(result.additional_results[1].truncated, true);
    assert.equal(client.internalRows, 0);
});

test('streamed byte budget truncates unpaged output and rejects shortened explicit pages after draining', async () => {
    const rows = [['x'.repeat(MAX_RESULT_BYTES / 2)], ['y'.repeat(MAX_RESULT_BYTES / 2)]];
    const make = () =>
        new FakeClient({
            cursor: false,
            results: [
                {
                    command: 'SELECT',
                    rows,
                    fields: [{name: 'large', dataTypeID: 25}],
                },
                {command: 'UPDATE', affected: 1, rows: [], fields: []},
            ],
        });
    const result = await executeSql(make(), 'SELECT large; UPDATE t SET n=1', null, 1);
    assert.equal(result.rows.length, 1);
    assert.equal(result.truncated, true);
    assert.equal(result.additional_results[0].affected_rows, 1);
    const client = make();
    await assert.rejects(
        executeSql(client, 'SELECT large; UPDATE t SET n=1', 2, 1),
        /Query completed.*may have committed/,
    );
    assert.equal(client.internalRows, 0);
});

test('fetch errors never retry original SQL and roll back the cursor transaction', async () => {
    const client = new FakeClient({fetchError: true});
    await assert.rejects(executeSql(client, 'SELECT side_effect()', 2, 1), /Fetch failed/);
    assert.equal(client.calls.filter((call) => call.text === 'SELECT side_effect()').length, 0);
    assert.equal(client.calls.at(-1).text, 'ROLLBACK');
});

test('an overall cursor deadline terminates a stalled fetch without executing the original again', async (t) => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const client = new FakeClient();
    const query = client.query.bind(client);
    let pending;
    client.query = (input) => {
        if (input instanceof pg.Query && input.text.startsWith('FETCH')) {
            pending = input;
            return input;
        }
        return query(input);
    };
    let ended = false;
    client.end = async () => {
        ended = true;
        pending.handleError(new Error('Connection terminated'));
    };
    const execution = executeSql(client, 'SELECT slow()', 1, 1);
    const rejected = assert.rejects(execution, /Query timed out/);
    for (let i = 0; i < 10 && !pending; i++) await Promise.resolve();
    assert(pending);
    t.mock.timers.tick(30000);
    await rejected;
    assert.equal(ended, true);
    assert.equal(
        client.calls.some((call) => call.text === 'SELECT slow()'),
        false,
    );
});

test('the same deadline remains active while draining a non-cursor SQL batch', async (t) => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const client = new FakeClient({cursor: false});
    const query = client.query.bind(client);
    let pending;
    client.query = (input) => {
        if (input instanceof pg.Query) {
            pending = input;
            return input;
        }
        return query(input);
    };
    let ended = false;
    client.end = async () => {
        ended = true;
        pending.handleError(new Error('Connection terminated'));
    };
    const execution = executeSql(client, 'UPDATE t SET n=1; SELECT slow()', 1, 1);
    const rejected = assert.rejects(execution, /Query timed out; statements may have committed/);
    for (let i = 0; i < 20 && !pending; i++) await Promise.resolve();
    assert(pending);
    t.mock.timers.tick(30000);
    await rejected;
    assert.equal(ended, true);
});

test(
    'real PostgreSQL preserves batch transactions, DML and cursor query syntax',
    {skip: !process.env.SQL_PAGINATION_TEST_URL},
    async () => {
        const client = new pg.Client({
            connectionString: process.env.SQL_PAGINATION_TEST_URL,
        });
        await client.connect();
        try {
            await client.query('CREATE TEMP TABLE pagination_test (n integer)');
            const page = await executeSql(
                client,
                '/* header */ SELECT generate_series(1,100000) AS n; -- tail',
                2,
                3,
            );
            assert.deepEqual(page.rows, [[5], [6]]);
            assert.equal(
                page.pagination.total_rows,
                null,
                'a null count establishes the cursor path',
            );
            assert.equal(page.pagination.has_more, true);
            const empty = await executeSql(client, '-- only a comment', 2, 1);
            assert.deepEqual(empty, {
                columns: [],
                rows: [],
                affected_rows: 0,
                truncated: false,
                pagination: null,
                additional_results: [],
            });
            const quoted = await executeSql(client, "SELECT ';' AS quoted, $$;$$ AS dollar", 1, 1);
            assert.deepEqual(quoted.rows, [[';', ';']]);
            const written = await executeSql(
                client,
                'WITH inserted AS (INSERT INTO pagination_test VALUES (1),(2),(3) RETURNING n) SELECT n FROM inserted ORDER BY n',
                2,
                1,
            );
            assert.deepEqual(written.rows, [[1], [2]]);
            assert.equal(
                (await client.query('SELECT count(*)::int AS n FROM pagination_test')).rows[0].n,
                3,
            );
            const batch = await executeSql(
                client,
                'INSERT INTO pagination_test VALUES (4) RETURNING n; SELECT n FROM pagination_test ORDER BY n',
                2,
                1,
            );
            assert.equal(batch.affected_rows, 1);
            assert.deepEqual(batch.additional_results[0].rows, [[1], [2]]);
            const updated = await executeSql(
                client,
                'UPDATE pagination_test SET n=n WHERE n<=3',
                2,
                1,
            );
            assert.equal(updated.affected_rows, 3);
            assert.deepEqual(updated.columns, []);
            assert.equal(updated.pagination, null);
            await assert.rejects(
                executeSql(
                    client,
                    'INSERT INTO pagination_test VALUES (5); SELECT 1/0; INSERT INTO pagination_test VALUES (6)',
                    2,
                    1,
                ),
                /division by zero/,
            );
            assert.deepEqual(
                (await client.query('SELECT n FROM pagination_test ORDER BY n')).rows.map(
                    (row) => row.n,
                ),
                [1, 2, 3, 4],
            );
            const unpaged = await executeSql(
                client,
                `SELECT generate_series(1,${MAX_QUERY_ROWS + 100}) AS n`,
                null,
                1,
            );
            assert.equal(unpaged.rows.length, MAX_QUERY_ROWS);
            assert.equal(unpaged.truncated, true);
            await assert.rejects(
                executeSql(client, "SELECT repeat('x',5000000) FROM generate_series(1,2)", 2, 1),
                /8 MiB/,
            );
            assert.equal(
                (await client.query('SELECT 1 AS n')).rows[0].n,
                1,
                'cursor errors leave a usable transaction state',
            );
        } finally {
            await client.end();
        }
    },
);
