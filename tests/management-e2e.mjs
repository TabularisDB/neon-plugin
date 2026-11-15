import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';

assert.equal(
    process.env.NEON_MANAGEMENT_TEST_ALLOW_MUTATIONS,
    '1',
    'Set NEON_MANAGEMENT_TEST_ALLOW_MUTATIONS=1 for disposable branch, SQL and Auth writes',
);
const apiKey = process.env.NEON_MANAGEMENT_TEST_API_KEY;
const cliProfile = process.env.NEON_MANAGEMENT_TEST_CLI_PROFILE;
const cliConfig = process.env.NEON_MANAGEMENT_TEST_CLI_CONFIG_DIR;
const scope = {
    projectId: process.env.NEON_MANAGEMENT_TEST_PROJECT_ID,
    branchId: process.env.NEON_MANAGEMENT_TEST_BRANCH_ID,
};
const expectedName = process.env.NEON_MANAGEMENT_TEST_EXPECT_BRANCH_NAME;
assert(
    Boolean(apiKey) !== Boolean(cliProfile),
    'Choose an explicit test API key or CLI profile',
);
assert(!cliProfile || cliConfig, 'Select the CLI configuration directory explicitly');
assert(scope.projectId && scope.branchId, 'Select an explicit disposable project and branch');
assert(
    expectedName?.startsWith('tabularis-'),
    'Supply the expected disposable tabularis-* branch name',
);
if (cliProfile) process.env.NEON_CONFIG_DIR = cliConfig;

const {account} = await import('../dist/account.js');
const {database} = await import('../dist/database.js');
const {extension} = await import('../dist/scope.js');
const credentials = cliProfile ? {NEON_CLI_AUTH: cliProfile} : {NEON_API_KEY: apiKey};
const call = (method, args = {}) => account(method, {...scope, ...args}, credentials);
const suffix = randomBytes(6).toString('hex');
const name = `tabularis-e2e-${suffix}`;
const renamed = `${name}-renamed`;
const table = `tabularis_e2e_${suffix}`;
const email = `${name}@example.com`;
let source;
let childId;
let branchAttempted = false;
let userId;
let tableCreated = false;
let checks = 0;
const sql = (params, query) => database('execute_query', {params, query});
const read = (method, args = {}) =>
    extension({
        method,
        args,
        params: source.params,
        secrets: source.secrets,
        context: {plugin_id: 'neon', connection_id: 'disposable-management-e2e'},
    });
async function check(label, action) {
    await action();
    checks += 1;
    console.log(`PASS ${label}`);
}

try {
    const branch = (await call('account_branch_list')).branches.find(
        (item) => item.id === scope.branchId,
    );
    assert(
        branch && branch.name === expectedName,
        'Selected branch does not match the disposable scope',
    );
    assert(
        !branch.isDefault && !branch.protected,
        'Never mutate a default or protected branch',
    );
    const resources = await call('account_resources');
    assert(
        resources.services.some((item) => item.id === 'auth' && item.enabled),
        'Disposable scope needs Auth enabled',
    );
    source = await call('account_import', {
        database: 'neondb',
        role: 'neondb_owner',
        createServiceCredentials: false,
    });
    await check('Explicit-parent branch creation, rename and real SQL isolation', async () => {
        await sql(source.params, `CREATE TABLE public.${table} (value text NOT NULL)`);
        tableCreated = true;
        await sql(source.params, `INSERT INTO public.${table} VALUES ('source')`);
        branchAttempted = true;
        const child = await call('account_branch_create', {name, parentId: scope.branchId});
        childId = child.id;
        assert.equal(child.parentId, scope.branchId);
        const updated = await call('account_branch_rename', {
            targetBranchId: childId,
            name: renamed,
        });
        assert.equal(updated.name, renamed);
        const imported = await call('account_import', {
            branchId: childId,
            database: 'neondb',
            role: 'neondb_owner',
            createServiceCredentials: false,
        });
        assert.notEqual(imported.params.host, source.params.host);
        await sql(imported.params, `UPDATE public.${table} SET value = 'child'`);
        assert.deepEqual((await sql(source.params, `SELECT value FROM public.${table}`)).rows, [
            ['source'],
        ]);
        assert.deepEqual(
            (await sql(imported.params, `SELECT value FROM public.${table}`)).rows,
            [['child']],
        );
    });
    await check(
        'Branch deletion requires the exact fresh name and deletes only the test branch',
        async () => {
            await assert.rejects(
                call('account_branch_delete', {targetBranchId: childId, confirmName: 'wrong'}),
                /exactly/,
            );
            await call('account_branch_delete', {
                targetBranchId: childId,
                confirmName: renamed,
            });
            assert(
                !(await call('account_branch_list')).branches.some(
                    (item) => item.id === childId,
                ),
            );
            childId = undefined;
        },
    );
    await check(
        'Auth creation is visible through the connection-scoped directory',
        async () => {
            const created = await call('account_auth_create_user', {
                email,
                name: 'Tabularis disposable user',
            });
            userId = created.id;
            assert(userId);
            assert(
                (await read('neon_auth_users_page', {search: email, limit: 20})).users.some(
                    (item) => item.id === userId,
                ),
            );
            assert.equal((await read('neon_auth_user_details', {userId})).user.email, email);
        },
    );
    await check(
        'Auth role changes and deletion affect only the newly created user',
        async () => {
            for (const role of ['admin', 'user']) {
                await call('account_auth_set_role', {userId, role});
                assert.equal((await read('neon_auth_user_details', {userId})).user.role, role);
            }
            await call('account_auth_delete_user', {userId});
            userId = undefined;
            assert.equal(
                (await read('neon_auth_users_page', {search: email, limit: 20})).total,
                0,
            );
        },
    );
    console.log(
        `PASS ${checks} live branch/Auth checks in the explicitly selected disposable scope`,
    );
} catch (error) {
    // Imported SQL credentials and remote error bodies must never reach the test output.
    console.error(
        error instanceof assert.AssertionError
            ? error.message
            : 'Disposable management test failed',
    );
    process.exitCode = 1;
} finally {
    if (userId)
        await call('account_auth_delete_user', {userId}).catch(() => {
            console.error('Disposable user cleanup failed');
            process.exitCode = 1;
        });
    const branches = branchAttempted
        ? (await call('account_branch_list').catch(() => ({branches: []}))).branches
        : [];
    const child = branches.find(
        (item) =>
            item.id !== scope.branchId &&
            (item.id === childId || item.name === name || item.name === renamed),
    );
    if (child)
        await call('account_branch_delete', {
            targetBranchId: child.id,
            confirmName: child.name,
        }).catch(() => {
            console.error('Disposable branch cleanup failed');
            process.exitCode = 1;
        });
    if (tableCreated)
        await sql(source.params, `DROP TABLE IF EXISTS public.${table}`).catch(() => {
            console.error('Disposable SQL table cleanup failed');
            process.exitCode = 1;
        });
}
