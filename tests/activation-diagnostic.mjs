import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {createNeonClient} from '@neon/sdk';
import {account} from '../dist/account.js';
import {cliCredential} from '../dist/cliAuth.js';

assert.equal(
    process.env.NEON_MANAGEMENT_TEST_ALLOW_MUTATIONS,
    '1',
    'Set NEON_MANAGEMENT_TEST_ALLOW_MUTATIONS=1 to create and delete a disposable diagnostic function',
);
const profile = process.env.NEON_MANAGEMENT_TEST_CLI_PROFILE;
const suppliedKey = process.env.NEON_MANAGEMENT_TEST_API_KEY;
assert(Boolean(profile) !== Boolean(suppliedKey), 'Choose an explicit CLI profile or test API key');
const apiKey = profile ? await cliCredential(profile) : suppliedKey;
const propagationMs = Number(process.env.NEON_MANAGEMENT_TEST_PROPAGATION_MS ?? 180000);
assert(
    Number.isSafeInteger(propagationMs) && propagationMs >= 0 && propagationMs <= 300000,
    'Propagation window must be between 0 and 300000 milliseconds',
);
const scope = {
    projectId: process.env.NEON_MANAGEMENT_TEST_PROJECT_ID,
    branchId: process.env.NEON_MANAGEMENT_TEST_BRANCH_ID,
};
assert(apiKey, 'Set an explicit test API key or named CLI profile');
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
const evidence = {
    functionSlug: slug,
    authentication: profile ? 'explicit-cli-profile' : 'explicit-api-key',
    propagationMs,
    observations: [],
    failures: [],
};
let created = false;
async function ready(id) {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
        const value = await sdk.functions.get({...scope, slug});
        const currentId = Number(value.current_deployment?.id);
        if (Number.isSafeInteger(currentId) && currentId > Number(id))
            throw new Error('Diagnostic deployment was superseded');
        if (
            String(value.current_deployment?.id) === id &&
            value.current_deployment.status === 'failed'
        )
            throw new Error('Diagnostic deployment failed');
        if (
            String(value.current_deployment?.id) === id &&
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
    const started = Date.now();
    let last = [];
    do {
        last = [];
        for (const method of ['GET', 'POST']) {
            const verification = await call('account_function_verify', {
                expectedDeploymentId: deployment.id,
                expectedMarker: JSON.stringify(expected),
                method,
            });
            // A new HTTP connection is an independent request, not a forced cold runtime.
            const response = await fetch(current.invocation_url, {
                method,
                headers: {connection: 'close', 'cache-control': 'no-cache'},
                redirect: 'manual',
                signal: AbortSignal.timeout(15000),
            });
            const body = await response.json();
            const matches =
                response.ok && body.revision === expected.revision && body.B === expected.B;
            evidence.observations.push({
                label,
                method,
                deploymentId: deployment.id,
                observedAt: new Date().toISOString(),
                elapsedMs: Date.now() - started,
                currentDeploymentId: String(current.current_deployment?.id),
                activeDeploymentId: String(current.active_deployment?.id),
                metadataStatus: current.current_deployment?.status,
                verification,
                body,
            });
            if (verification.runtimeVerification !== 'verified' || !matches)
                last.push(`${label} ${method}: expected code/environment revision was not served`);
        }
        if (!last.length || Date.now() - started >= propagationMs) break;
        console.log(
            JSON.stringify({phase: label, runtime: 'mismatch', elapsedMs: Date.now() - started}),
        );
        await new Promise((resolve) =>
            setTimeout(resolve, Math.min(10000, propagationMs - (Date.now() - started))),
        );
    } while (true);
    evidence.failures.push(...last);
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
