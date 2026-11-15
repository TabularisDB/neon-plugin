import pg from 'pg';
import {randomUUID} from 'node:crypto';

export const MAX_QUERY_ROWS = 10000;
export const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const FETCH_ROWS = 128;

interface Page {
    limit: number | null;
    size: number;
    page: number;
    offset: number;
}
interface Result {
    columns: string[];
    rows: unknown[][];
    affected_rows: number;
    truncated: boolean;
    pagination: {
        page: number;
        page_size: number;
        total_rows: number | null;
        has_more: boolean;
    } | null;
}
type PgResult = pg.QueryArrayResult<unknown[]>;

function pageOptions(limit: unknown, page: unknown): Page {
    if (
        limit !== undefined &&
        limit !== null &&
        (typeof limit !== 'number' ||
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > MAX_QUERY_ROWS)
    )
        throw new Error(`Query page size must be between 1 and ${MAX_QUERY_ROWS}`);
    if (page !== undefined && (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1))
        throw new Error('Query page must be a positive safe integer');
    const size = typeof limit === 'number' ? limit : MAX_QUERY_ROWS;
    const current = typeof page === 'number' ? page : 1;
    const offset = typeof limit === 'number' ? (current - 1) * size : 0;
    if (!Number.isSafeInteger(offset)) throw new Error('Query page offset is too large');
    return {
        limit: typeof limit === 'number' ? limit : null,
        size,
        page: current,
        offset,
    };
}

/** A row listener without a callback keeps pg from also accumulating every row internally. */
function streamQuery(
    client: pg.Client,
    text: string,
    row: (value: unknown[], result: PgResult) => void,
): Promise<PgResult[]> {
    return new Promise((resolve, reject) => {
        const config: pg.QueryArrayConfig = {text, rowMode: 'array'};
        const query = new pg.Query<unknown[]>(config);
        let rowError: unknown;
        query.on('row', (value, result) => {
            if (rowError) return;
            try {
                if (!result) throw new Error('Query result metadata is missing');
                row(value, result);
            } catch (error) {
                // Drain the statement: interrupting a batch could roll back writes or skip later commands.
                rowError = error;
            }
        });
        query.on('error', reject);
        query.on('end', (result) => {
            if (rowError) reject(rowError);
            else resolve(Array.isArray(result) ? result : [result]);
        });
        client.query(query);
    });
}

function pagination(page: Page, hasMore: boolean, total: number | null): Result['pagination'] {
    return page.limit === null
        ? null
        : {
              page: page.page,
              page_size: page.size,
              total_rows: total,
              has_more: hasMore,
          };
}

async function cursorPage(client: pg.Client, text: string, page: Page): Promise<Result | null> {
    await client.query('BEGIN');
    try {
        // A named query uses extended Parse, which rejects multiple statements before executing any.
        await client.query({
            name: `tabularis-page-${randomUUID()}`,
            text: `DECLARE "tabularis_page" NO SCROLL CURSOR FOR ${text}`,
        });
    } catch {
        await client.query('ROLLBACK');
        return null;
    }
    try {
        if (page.offset) await client.query(`MOVE FORWARD ${page.offset} FROM "tabularis_page"`);
        const rows: unknown[][] = [];
        let columns: string[] = [];
        let bytes = 0;
        let hasMore = false;
        let finished = false;
        while (!finished && !hasMore) {
            const count = Math.min(FETCH_ROWS, page.size + 1 - rows.length);
            let received = 0;
            const results = await streamQuery(
                client,
                `FETCH FORWARD ${count} FROM "tabularis_page"`,
                (row) => {
                    received++;
                    if (rows.length === page.size) {
                        hasMore = true;
                        return;
                    }
                    const length = Buffer.byteLength(JSON.stringify(row));
                    if (bytes + length > MAX_RESULT_BYTES) {
                        if (page.limit !== null)
                            throw new Error(
                                'Query page exceeds 8 MiB; request a smaller page size',
                            );
                        hasMore = true;
                        return;
                    }
                    if (!hasMore) {
                        rows.push(row);
                        bytes += length;
                    }
                },
            );
            columns = results[0].fields.map((field) => field.name);
            finished = received < count;
        }
        await client.query('CLOSE "tabularis_page"');
        await client.query('COMMIT');
        return {
            columns,
            rows,
            affected_rows: 0,
            truncated: hasMore,
            pagination: pagination(page, hasMore, null),
        };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    }
}

async function batchResults(client: pg.Client, text: string, page: Page): Promise<Result[]> {
    const windows = new Map<PgResult, {seen: number; rows: unknown[][]; truncated: boolean}>();
    let bytes = 0;
    let retained = 0;
    let oversizedPage = false;
    const results = await streamQuery(client, text, (row, result) => {
        let window = windows.get(result);
        if (!window) {
            window = {seen: 0, rows: [], truncated: false};
            windows.set(result, window);
        }
        const index = window.seen++;
        if (index < page.offset || index >= page.offset + page.size) return;
        if (window.truncated) return;
        const length = Buffer.byteLength(JSON.stringify(row));
        if (retained >= MAX_QUERY_ROWS || bytes + length > MAX_RESULT_BYTES) {
            window.truncated = true;
            oversizedPage = page.limit !== null;
            return;
        }
        window.rows.push(row);
        retained++;
        bytes += length;
    });
    if (oversizedPage)
        throw new Error(
            'Query completed, but its result pages exceed the 10000-row/8 MiB response limit; statements may have committed. Request smaller pages.',
        );
    if (results.length > 128)
        throw new Error(
            'Query completed, but more than 128 result sets cannot be returned; statements may have committed.',
        );
    return results.map((result) => {
        const window = windows.get(result) ?? {
            seen: 0,
            rows: [],
            truncated: false,
        };
        const hasMore = window.seen > page.offset + page.size;
        return {
            columns: result.fields.map((field) => field.name),
            rows: window.rows,
            affected_rows: result.command === 'SELECT' ? 0 : (result.rowCount ?? 0),
            truncated: window.truncated || hasMore,
            pagination: result.fields.length ? pagination(page, hasMore, window.seen) : null,
        };
    });
}

export async function executeSql(
    client: pg.Client,
    text: string,
    limit: unknown,
    page: unknown,
): Promise<Result & {additional_results: Result[]}> {
    const options = pageOptions(limit, page);
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        void client.end().catch(() => undefined);
    }, 30000);
    try {
        const single = await cursorPage(client, text, options);
        if (timedOut) throw new Error('Query timed out');
        const results = single ? [single] : await batchResults(client, text, options);
        return {...results[0], additional_results: results.slice(1)};
    } catch (error) {
        throw timedOut ? new Error('Query timed out; statements may have committed') : error;
    } finally {
        clearTimeout(timer);
    }
}
