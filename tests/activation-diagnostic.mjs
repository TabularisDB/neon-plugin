import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {createNeonClient} from '@neon/sdk';
import {account} from '../dist/account.js';

assert.equal(
    process.env.NEON_MANAGEMENT_TEST_ALLOW_MUTATIONS,
    '1',
    'Set NEON_MANAGEMENT_TEST_ALLOW_MUTATIONS=1 to create and delete a disposable diagnostic function',
);
const apiKey = process.env.NEON_MANAGEMENT_TEST_API_KEY;
const scope = {
    projectId: process.env.NEON_MANAGEMENT_TEST_PROJECT_ID,
    branchId: process.env.NEON_MANAGEMENT_TEST_BRANCH_ID,
};
assert(apiKey, 'Set NEON_MANAGEMENT_TEST_API_KEY explicitly; saved CLI credentials are never read');
assert(scope.projectId, 'Set NEON_MANAGEMENT_TEST_PROJECT_ID to an authorized disposable project');
assert(scope.branchId, 'Set NEON_MANAGEMENT_TEST_BRANCH_ID to an authorized disposable branch');
const credentials = {NEON_API_KEY: apiKey};
const slug = `tabdiag${randomBytes(5).toString('hex')}`;
const sdk = createNeonClient({
    apiKey,
    throwOnError: true,
    requestTimeoutMs: 15000,
    retries: 0,
});
const call = (method, args = {}) => account(method, {...scope, slug, ...args}, credentials);
const source = (revision) =>
    `export default { fetch() { return Response.json({revision:${revision},B:process.env.TABULARIS_TEST_B ?? null}); } };`;
const evidence = {functionSlug: slug, observations: [], failures: []};
let created = false;
async function ready(id) {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
        const value = await sdk.functions.get({...scope, slug});
        if (String(value.current_deployment?.id) !== id)
            throw new Error('Diagnostic deployment was superseded');
        if (value.current_deployment?.status === 'failed')
            throw new Error('Diagnostic deployment failed');
        if (
            String(value.active_deployment?.id) === id &&
            value.current_deployment.status === 'completed'
        )
            return value;
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('Diagnostic readiness timed out');
}
async function inspect(label, deployment, expected) {
    const current = await ready(deployment.id);
    for (const method of ['GET', 'POST']) {
        const verification = await call('account_function_verify', {
            expectedDeploymentId: deployment.id,
            expectedMarker: JSON.stringify(expected),
            method,
        });
        // Independent HTTP evidence uses a new connection and synthetic values only.
        const response = await fetch(current.invocation_url, {
            method,
            headers: {connection: 'close'},
            redirect: 'manual',
            signal: AbortSignal.timeout(15000),
        });
        const body = await response.json();
        const matches = response.ok && body.revision === expected.revision && body.B === expected.B;
        evidence.observations.push({
            label,
            method,
            deploymentId: deployment.id,
            verification,
            body,
        });
        if (verification.runtimeVerification !== 'verified' || !matches)
            evidence.failures.push(
                `${label} ${method}: expected code/environment revision was not served`,
            );
    }
}
try {
    const first = await call('account_function_deploy', {
        source: source(1),
        createOnly: true,
        envChanges: {TABULARIS_TEST_B: 'beta'},
    });
    created = true;
    assert.equal(first.runtimeVerification, 'unverified');
    await inspect('initial', first, {revision: 1, B: 'beta'});
    const next = await call('account_function_deploy', {
        source: source(2),
        envChanges: {TABULARIS_TEST_B: 'changed'},
    });
    assert.equal(next.runtimeVerification, 'unverified');
    await inspect('code-and-environment-update', next, {
        revision: 2,
        B: 'changed',
    });
    const environmentOnly = await call('account_function_deploy', {
        envChanges: {TABULARIS_TEST_B: 'environment-only'},
    });
    assert.equal(environmentOnly.runtimeVerification, 'unverified');
    await inspect('environment-only-update', environmentOnly, {
        revision: 2,
        B: 'environment-only',
    });
    if (evidence.failures.length) {
        evidence.error =
            'Neon accepted a deployment but did not serve its expected code/environment revision';
        process.exitCode = 1;
    }
} catch (error) {
    evidence.error =
        error instanceof Error
            ? error.message.replaceAll(apiKey, '[credential]')
            : 'Diagnostic failed';
    process.exitCode = 1;
} finally {
    if (created) {
        try {
            await call('account_function_delete');
            evidence.cleanup = 'Disposable diagnostic function deleted';
        } catch {
            evidence.cleanup = `Cleanup failed; delete diagnostic function ${slug} manually`;
            process.exitCode = 1;
        }
    }
    const output = new URL(
        '../artifacts/management-connection-activation-repro.json',
        import.meta.url,
    );
    await mkdir(new URL('.', output), {recursive: true});
    await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
    console.log(
        JSON.stringify({
            functionSlug: slug,
            failures: evidence.failures.length,
            cleanup: evidence.cleanup,
        }),
    );
    if (evidence.error) console.error(evidence.error);
}
