import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {createNeonClient, isNeonError} from '@neon/sdk';
import {strToU8, zipSync} from 'fflate';
import {cliCredential} from '../dist/cliAuth.js';

assert.equal(
    process.env.NEON_CONTROL_ALLOW_MUTATIONS,
    '1',
    'Explicit disposable Function mutation opt-in required',
);
const scope = {
    projectId: process.env.NEON_CONTROL_PROJECT_ID,
    branchId: process.env.NEON_CONTROL_BRANCH_ID,
};
assert(
    scope.projectId && scope.branchId,
    'Select an explicitly authorized disposable project and branch',
);
const profile = process.env.NEON_CONTROL_CLI_PROFILE;
assert(profile, 'Select the existing CLI profile explicitly');
const slug = `tabctrl${randomBytes(5).toString('hex')}`;
const key = await cliCredential(profile);
const sdk = createNeonClient({
    apiKey: key,
    throwOnError: true,
    requestTimeoutMs: 15000,
    retries: 0,
});
const target = {...scope, slug};
const evidence = {
    startedAt: new Date().toISOString(),
    scope,
    slug,
    deployments: [],
    observations: [],
};
let attempted = false;

function bundle(revision) {
    const source = `const boot=Math.random().toString(36).slice(2);export default {fetch(request){const url=new URL(request.url);return Response.json({revision:${revision},B:process.env.TABULARIS_CONTROL_B??null,nonce:request.headers.get('x-tabularis-control-nonce')??url.searchParams.get('nonce'),boot,servedAt:Date.now()},{headers:{'cache-control':'no-store, max-age=0','x-control-revision':'${revision}'}})}};`;
    const zip = zipSync({'index.mjs': strToU8(source)});
    return {
        zip: new File([Buffer.from(zip)], 'function.zip', {type: 'application/zip'}),
        sha256: createHash('sha256').update(zip).digest('hex'),
    };
}

function metadata(value) {
    return {
        functionId: value.id,
        invocationUrl: value.invocation_url,
        currentId: value.current_deployment?.id ?? null,
        currentStatus: value.current_deployment?.status ?? null,
        activeId: value.active_deployment?.id ?? null,
        activeStatus: value.active_deployment?.status ?? null,
    };
}

async function ready(id) {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
        const value = await sdk.functions.get(target);
        if (value.current_deployment?.id > id) throw new Error('Control deployment was superseded');
        if (value.current_deployment?.id === id && value.current_deployment.status === 'failed')
            throw new Error('Control deployment build failed');
        if (
            value.current_deployment?.id === id &&
            value.current_deployment.status === 'completed' &&
            value.active_deployment?.id === id
        )
            return value;
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error('Control deployment metadata timed out');
}

async function probes(stage, value, expectedRevision, expectedEnvironment, elapsedMs) {
    const url = new URL(value.invocation_url);
    assert.equal(url.protocol, 'https:');
    assert(
        url.hostname.startsWith(`${scope.branchId}-${slug}.`) &&
            url.hostname.endsWith('.neon.tech'),
    );
    const observed = [];
    for (const mode of ['canonical-get', 'nonce-get-no-cache', 'canonical-post-no-cache']) {
        const nonce = randomBytes(10).toString('hex');
        const endpoint = new URL(url);
        const method = mode.includes('post') ? 'POST' : 'GET';
        if (mode.startsWith('nonce')) endpoint.searchParams.set('nonce', nonce);
        const response = await fetch(endpoint, {
            method,
            headers: {
                connection: 'close',
                'x-tabularis-control-nonce': nonce,
                ...(mode.includes('no-cache')
                    ? {'cache-control': 'no-cache', pragma: 'no-cache'}
                    : {}),
                ...(method === 'POST' ? {'content-type': 'application/json'} : {}),
            },
            ...(mode.includes('no-cache') ? {cache: 'no-store'} : {}),
            ...(method === 'POST' ? {body: JSON.stringify({nonce})} : {}),
            redirect: 'manual',
            signal: AbortSignal.timeout(15000),
        });
        let body;
        try {
            body = await response.json();
        } catch {
            body = {};
        }
        const matches =
            response.ok &&
            body.revision === expectedRevision &&
            body.B === expectedEnvironment &&
            body.nonce === nonce;
        const record = {
            stage,
            mode,
            elapsedMs,
            at: new Date().toISOString(),
            metadata: metadata(value),
            status: response.status,
            revision: typeof body.revision === 'number' ? body.revision : null,
            environment: ['beta', 'changed'].includes(body.B) ? body.B : 'unexpected-or-missing',
            nonceEchoMatches: body.nonce === nonce,
            boot:
                typeof body.boot === 'string' && /^[a-z0-9]{1,32}$/.test(body.boot)
                    ? body.boot
                    : null,
            servedAt: typeof body.servedAt === 'number' ? body.servedAt : null,
            responseHeaders: Object.fromEntries(
                [
                    'cache-control',
                    'age',
                    'etag',
                    'x-cache',
                    'cf-cache-status',
                    'x-control-revision',
                    'date',
                ].map((name) => [name, response.headers.get(name)]),
            ),
            matches,
        };
        evidence.observations.push(record);
        observed.push(record);
    }
    console.log(
        JSON.stringify({
            stage,
            elapsedMs,
            metadata: metadata(value),
            observations: observed.map(
                ({mode, revision, environment, nonceEchoMatches, matches, boot}) => ({
                    mode,
                    revision,
                    environment,
                    nonceEchoMatches,
                    matches,
                    boot,
                }),
            ),
        }),
    );
    return observed.every((item) => item.matches);
}

try {
    const initialBundle = bundle(1);
    attempted = true;
    const initial = await sdk.functions.deploy({
        ...target,
        zip: initialBundle.zip,
        runtime: 'nodejs24',
        environment: JSON.stringify({TABULARIS_CONTROL_B: 'beta'}),
    });
    evidence.deployments.push({
        transport: 'sdk-7.6.1',
        revision: 1,
        environment: 'beta',
        deploymentId: initial.id,
        zipSha256: initialBundle.sha256,
    });
    const first = await ready(initial.id);
    assert(
        await probes('initial-sdk', first, 1, 'beta', 0),
        'Initial control revision did not serve correctly',
    );
    const updatedBundle = bundle(2);
    assert.notEqual(initialBundle.sha256, updatedBundle.sha256);
    const form = new FormData();
    form.set('zip', updatedBundle.zip);
    form.set('runtime', 'nodejs24');
    form.set('environment', JSON.stringify({TABULARIS_CONTROL_B: 'changed'}));
    const deployed = await fetch(
        `https://console.neon.tech/api/v2/projects/${encodeURIComponent(scope.projectId)}/branches/${encodeURIComponent(scope.branchId)}/functions/${slug}/deployments`,
        {
            method: 'POST',
            headers: {authorization: `Bearer ${key}`},
            body: form,
            signal: AbortSignal.timeout(15000),
        },
    );
    if (!deployed.ok) throw new Error(`Raw multipart deployment returned HTTP ${deployed.status}`);
    const {deployment} = await deployed.json();
    evidence.deployments.push({
        transport: 'raw-multipart-http',
        revision: 2,
        environment: 'changed',
        deploymentId: deployment.id,
        zipSha256: updatedBundle.sha256,
    });
    await ready(deployment.id);
    const started = Date.now();
    while (true) {
        const value = await sdk.functions.get(target);
        if (
            value.current_deployment?.id !== deployment.id ||
            value.active_deployment?.id !== deployment.id
        )
            throw new Error('Stable control deployment IDs changed while observing runtime');
        const elapsedMs = Date.now() - started;
        if (await probes('raw-update-stable', value, 2, 'changed', elapsedMs)) {
            evidence.outcome = 'runtime-converged';
            evidence.convergedAfterMs = elapsedMs;
            break;
        }
        if (elapsedMs >= 120000) {
            evidence.outcome = 'stale-runtime-after-120s';
            process.exitCode = 1;
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10000));
    }
} catch (error) {
    evidence.outcome = 'control-failed';
    evidence.error =
        error instanceof Error
            ? error.message.replaceAll(key, '[credential]')
            : 'Control diagnostic failed';
    process.exitCode = 1;
} finally {
    if (attempted) {
        try {
            await sdk.functions.delete(target);
            evidence.cleanup = 'Owned disposable control function deleted';
        } catch (error) {
            if (isNeonError(error) && 'status' in error && error.status === 404)
                evidence.cleanup = 'Owned control function was absent';
            else {
                evidence.cleanup = 'Owned control function cleanup failed';
                process.exitCode = 1;
            }
        }
    }
    evidence.finishedAt = new Date().toISOString();
    const output = new URL(
        '../artifacts/management-independent-activation-controls.json',
        import.meta.url,
    );
    await mkdir(new URL('.', output), {recursive: true});
    await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify({slug, outcome: evidence.outcome, cleanup: evidence.cleanup}));
}
