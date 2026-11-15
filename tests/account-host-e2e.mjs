import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp, mkdir, readFile, writeFile, rm, open} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';

// Live test scope is always supplied by the operator. Never default to an existing branch.
const projectId = process.env.NEON_ACCOUNT_TEST_PROJECT_ID;
const branchId = process.env.NEON_ACCOUNT_TEST_BRANCH_ID;
const branchName = process.env.NEON_ACCOUNT_TEST_EXPECT_BRANCH_NAME;
const orgId = process.env.NEON_ACCOUNT_TEST_ORG_ID;
const cliProfile = process.env.NEON_ACCOUNT_TEST_CLI_PROFILE;
const cliConfig = process.env.NEON_ACCOUNT_TEST_CLI_CONFIG_DIR;
const coreRoot = process.env.TABULARIS_CORE_ROOT && resolve(process.env.TABULARIS_CORE_ROOT);
assert.equal(
    process.env.NEON_ACCOUNT_TEST_AUTH_MODE,
    'cli',
    'Select explicit host CLI-profile authentication',
);
assert(
    projectId && branchId && branchName && cliProfile && cliConfig && coreRoot,
    'Supply explicit project, branch ID/name, CLI profile/config directory and Core root',
);
assert(
    branchName.startsWith('tabularis-pr1445-live-'),
    'Use a disposable branch created for this live regression',
);
const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const {chromium, expect} = createRequire(join(coreRoot, 'package.json'))('@playwright/test');
const manifest = JSON.parse(await readFile(join(pluginRoot, '.tabularium'), 'utf8'));
const temp = await mkdtemp(join(tmpdir(), 'tabularis-neon-live-web-'));
const config = join(temp, 'config');
const data = join(temp, 'data');
const artifacts = join(pluginRoot, 'artifacts');
const evidence = {
    apiVersion: '0.4.1',
    projectId,
    branchId,
    branchName,
    checks: [],
    pageErrors: [],
    providerMutations: [],
    accountRequests: 0,
};
const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));
let server;
let browser;
let page;
let cookie;
let csrf;
let connectionId;
let origin;
let log;
let ownFunctionSlug;
let ownFunctionCreated = false;

async function rpc(command, payload = {}) {
    const started = Date.now();
    const response = await fetch(`${origin}/api/v1/rpc/${command}`, {
        method: 'POST',
        headers: {origin, cookie, 'content-type': 'application/json', 'x-tabularis-csrf': csrf},
        body: JSON.stringify(payload),
    });
    const envelope = await response.json();
    if (!envelope.ok) {
        evidence.lastRpcFailure = {command, elapsedMs: Date.now() - started};
        throw new Error(`${command}: ${envelope.error?.message ?? response.status}`);
    }
    return envelope.data;
}
const account = (operation, payload = {}) =>
    rpc('plugin_account', {pluginId: 'neon', operation, ...payload});
const call = (method, args = {}) => account('call', {method, args});
async function check(name, action) {
    await action();
    evidence.checks.push(name);
    console.log(`PASS ${name}`);
}
async function guest(selector) {
    for (let attempt = 0; attempt < 250; attempt++) {
        for (const frame of page.frames()) {
            if (frame === page.mainFrame()) continue;
            try {
                const owner = await frame.frameElement();
                if (!(await owner.isVisible())) continue;
                if ((await owner.getAttribute('data-plugin-active')) === 'false') continue;
                if (await frame.locator(selector).first().isVisible()) return frame;
            } catch {}
        }
        await pause(100);
    }
    throw new Error(`No visible Neon sandbox frame for ${selector}`);
}
async function choose(frame, label, value) {
    const field = frame.getByLabel(label, {exact: true});
    await expect(field).toBeEnabled({timeout: 45000});
    await field.click();
    const option = frame.locator(`[data-plugin-select-menu] [data-value=${JSON.stringify(value)}]`);
    await option.waitFor();
    const menu = frame.locator('[data-plugin-select-menu]');
    const geometry = await menu.evaluate((element) => ({
        position: getComputedStyle(element).position,
        viewport: {width: innerWidth, height: innerHeight},
        menu: {
            top: element.getBoundingClientRect().top,
            bottom: element.getBoundingClientRect().bottom,
        },
    }));
    evidence.lastDropdownGeometry = geometry;
    await expect(menu).toHaveCSS('position', 'fixed');
    await option.click();
}

async function functionDetails() {
    return guest('.neon-functions input[id$="-name"]');
}
async function functionRequest(method, args = {}) {
    return call(method, {projectId, branchId, slug: ownFunctionSlug, ...args});
}
async function editFunctionSource(source) {
    const editor = page.getByRole('region', {name: 'Function source', exact: true});
    await editor.locator('.monaco-editor').waitFor();
    await editor.locator('.view-lines').click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type(source);
}
async function waitForRuntimeThroughUi(deploymentId, marker, label) {
    const started = Date.now();
    const deadline = started + 180000;
    let attempts = 0;
    while (Date.now() < deadline) {
        const metadata = await functionRequest('account_function_get');
        assert.equal(metadata.deploymentId, deploymentId, 'Owned test deployment was superseded');
        assert.notEqual(metadata.status, 'failed', 'Owned test Function deployment failed');
        if (metadata.status === 'completed' && metadata.activeDeploymentId === deploymentId) {
            const detail = await functionDetails();
            await detail.getByRole('button', {name: 'Refresh', exact: true}).click();
            const disclosure = detail.locator('summary').filter({hasText: /^Invoke function$/});
            if (!(await disclosure.locator('..').evaluate((element) => element.open)))
                await disclosure.click();
            await detail
                .getByLabel('Expected non-secret response marker', {exact: true})
                .fill(marker);
            const verificationResponse = page.waitForResponse(
                (response) =>
                    response.url().endsWith('/rpc/plugin_account') &&
                    response.request().postDataJSON()?.method === 'account_function_verify' &&
                    response.request().postDataJSON()?.args?.slug === ownFunctionSlug,
            );
            await detail
                .getByRole('button', {name: 'Send request and verify deployment', exact: true})
                .click();
            const verification = await (await verificationResponse).json();
            assert.equal(verification.ok, true, verification.error?.message);
            attempts++;
            if (verification.data.runtimeVerification === 'verified') {
                await detail
                    .getByText(
                        `Expected response marker matched deployment ${deploymentId} during this check.`,
                        {exact: true},
                    )
                    .waitFor();
                evidence.functionChecks.push({
                    label,
                    deploymentId,
                    attempts,
                    elapsedMs: Date.now() - started,
                    runtimeVerification: 'verified',
                });
                return;
            }
            assert(['mismatch', 'unverified'].includes(verification.data.runtimeVerification));
        }
        await pause(5000);
    }
    throw new Error(
        `Owned test Function ${label} did not serve the expected marker within 180 seconds`,
    );
}
async function deployThroughUi(detail, create) {
    const response = page.waitForResponse(
        (response) =>
            response.url().endsWith('/rpc/plugin_account') &&
            response.request().postDataJSON()?.method === 'account_function_deploy' &&
            response.request().postDataJSON()?.args?.slug === ownFunctionSlug,
    );
    await detail.getByRole('button', {name: 'Deploy function', exact: true}).click();
    if (!create)
        await detail.getByRole('button', {name: 'Confirm deployment', exact: true}).click();
    const result = await (await response).json();
    assert.equal(result.ok, true, result.error?.message);
    ownFunctionCreated = true;
    evidence.ownFunctionCreated = true;
    assert.equal(result.data.runtimeVerification, 'unverified');
    evidence.ownFunctionDeploymentId = result.data.id;
    console.log(
        `Owned Function deployment ${result.data.id} accepted; runtime verification pending`,
    );
    await writeFile(join(artifacts, 'live-web-e2e.json'), JSON.stringify(evidence, null, 2) + '\n');
    return result.data.id;
}
async function liveFunctionUi(explorer) {
    ownFunctionSlug = `tabweb${randomBytes(5).toString('hex')}`;
    evidence.ownFunctionSlug = ownFunctionSlug;
    evidence.functionChecks = [];
    // Record ownership before the first possible mutation so a failed browser run can be cleaned up.
    await writeFile(join(artifacts, 'live-web-e2e.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log(`Owned disposable UI Function: ${ownFunctionSlug}`);
    const source = (revision) =>
        `export default {fetch() {return Response.json({marker:"web-revision-${revision}",environment:process.env.TABULARIS_WEB_TEST_VALUE ?? null});}};`;
    const functions = await guest('.neon-functions');
    await functions.getByRole('button', {name: 'New function', exact: true}).click();
    const create = await guest('.neon-functions input[id$="-slug"]');
    await create.getByLabel('Function slug', {exact: true}).fill(ownFunctionSlug);
    await editFunctionSource(source(1));
    const sourceLines = page
        .getByRole('region', {name: 'Function source', exact: true})
        .locator('.view-lines');
    await expect(sourceLines).toContainText('web-revision-1');
    await choose(create, 'Language', 'typescript');
    await expect(create.getByLabel('Language', {exact: true})).toHaveValue('TypeScript');
    await expect(
        page.getByRole('region', {name: 'Function source', exact: true}).locator('.monaco-editor'),
    ).toHaveAttribute('data-uri', /\/index\.ts$/);
    evidence.languageSourceAfter = (await sourceLines.innerText()).includes('web-revision-1');
    await expect(sourceLines).toContainText('web-revision-1');
    assert.equal(
        (await sourceLines.innerText()).replace(/\s/g, ''),
        source(1).replace(/\s/g, ''),
        'Changing language replaced the entered Function source',
    );
    evidence.functionLanguage = {language: 'typescript', sourceRetained: true};
    await check(
        'Language popup is pointer-reachable above Monaco and preserves entered source when switching to TypeScript',
        async () => {},
    );
    await create
        .locator('summary')
        .filter({hasText: /^Environment and secrets$/})
        .click();
    await create
        .getByLabel('Write-only environment changes (JSON)', {exact: true})
        .fill(JSON.stringify({TABULARIS_WEB_TEST_VALUE: 'initial'}));
    const initial = await deployThroughUi(create, true);
    await waitForRuntimeThroughUi(
        initial,
        JSON.stringify({marker: 'web-revision-1', environment: 'initial'}),
        'initial',
    );
    await check(
        'own disposable Function initial code/environment deploy and explicit GET verification work through web',
        async () => {},
    );
    let detail = await functionDetails();
    await editFunctionSource(source(2));
    const environment = detail.locator('summary').filter({hasText: /^Environment and secrets$/});
    if (!(await environment.locator('..').evaluate((element) => element.open)))
        await environment.click();
    await detail
        .getByLabel('Write-only environment changes (JSON)', {exact: true})
        .fill(JSON.stringify({TABULARIS_WEB_TEST_VALUE: 'updated'}));
    const updated = await deployThroughUi(detail, false);
    await waitForRuntimeThroughUi(
        updated,
        JSON.stringify({marker: 'web-revision-2', environment: 'updated'}),
        'code-and-environment-update',
    );
    await check(
        'own Function code/environment update becomes verified only after its actual response matches',
        async () => {},
    );
    detail = await functionDetails();
    const envDisclosure = detail.locator('summary').filter({hasText: /^Environment and secrets$/});
    if (!(await envDisclosure.locator('..').evaluate((element) => element.open)))
        await envDisclosure.click();
    await detail
        .getByLabel('Write-only environment changes (JSON)', {exact: true})
        .fill(JSON.stringify({TABULARIS_WEB_TEST_VALUE: 'environment-only'}));
    const envResponse = page.waitForResponse(
        (response) =>
            response.url().endsWith('/rpc/plugin_account') &&
            response.request().postDataJSON()?.method === 'account_function_deploy' &&
            response.request().postDataJSON()?.args?.slug === ownFunctionSlug,
    );
    await detail.getByRole('button', {name: 'Save environment changes', exact: true}).click();
    const envResult = await (await envResponse).json();
    assert.equal(envResult.ok, true, envResult.error?.message);
    assert.equal(envResult.data.runtimeVerification, 'unverified');
    await waitForRuntimeThroughUi(
        envResult.data.id,
        JSON.stringify({marker: 'web-revision-2', environment: 'environment-only'}),
        'environment-only-update',
    );
    await check(
        'own Function environment-only update works without falsely treating accepted metadata as runtime proof',
        async () => {},
    );
    detail = await functionDetails();
    await detail
        .locator('summary')
        .filter({hasText: /^Delete function$/})
        .click();
    await detail.getByRole('button', {name: 'Delete function', exact: true}).click();
    const deleted = page.waitForResponse(
        (response) =>
            response.url().endsWith('/rpc/plugin_account') &&
            response.request().postDataJSON()?.method === 'account_function_delete' &&
            response.request().postDataJSON()?.args?.slug === ownFunctionSlug,
    );
    await detail.getByRole('button', {name: 'Confirm deletion', exact: true}).click();
    const deletion = await (await deleted).json();
    assert.equal(deletion.ok, true, deletion.error?.message);
    ownFunctionCreated = false;
    evidence.ownFunctionDeleted = true;
    await check(
        'own disposable UI Function is deleted through confirmed web action',
        async () => {},
    );
    await explorer.getByRole('button', {name: 'Functions', exact: true}).click();
}

try {
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise((resolveClose) => reservation.close(resolveClose));
    origin = `http://127.0.0.1:${port}`;
    const pluginDirectory = join(data, 'tabularis', 'plugins', 'drivers', 'neon');
    for (const directory of [
        join(config, 'tabularis'),
        join(temp, 'home'),
        pluginDirectory,
        artifacts,
    ])
        await mkdir(directory, {recursive: true});
    const archive = join(
        pluginRoot,
        `neon-${manifest.version}-${process.platform}-${process.arch}.zip`,
    );
    const installed = spawnSync('unzip', ['-q', archive, '-d', pluginDirectory], {
        encoding: 'utf8',
    });
    assert.equal(installed.status, 0, 'Build/package the current Neon plugin before testing');
    await writeFile(
        join(config, 'tabularis', 'config.json'),
        JSON.stringify({
            activeExternalDrivers: ['neon'],
            autoConnectLastConnection: false,
            language: 'en',
            lastOpenConnectionIds: [],
            lastActiveConnectionId: null,
            showWelcome: false,
            checkForUpdates: false,
            autoCheckUpdatesOnStartup: false,
            pingInterval: 0,
        }),
    );
    const password = randomBytes(32).toString('base64url');
    log = await open(join(temp, 'server.log'), 'w', 0o600);
    server = spawn(
        join(coreRoot, 'src-tauri/target/debug/tabularis'),
        [
            'web',
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--no-open',
            '--auth',
            'password',
            '--allow-high-risk',
            '--public-url',
            origin,
            '--allowed-origin',
            origin,
            '--web-root',
            join(coreRoot, 'packages/web-ui/dist'),
        ],
        {
            env: {
                PATH: process.env.PATH,
                HOME: join(temp, 'home'),
                XDG_CONFIG_HOME: config,
                XDG_DATA_HOME: data,
                XDG_CACHE_HOME: join(temp, 'cache'),
                TMPDIR: temp,
                LANG: 'C.UTF-8',
                DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/neon-live-no-keychain',
                NEON_CONFIG_DIR: resolve(cliConfig),
                TABULARIS_WEB_PASSWORD: password,
                TABULARIS_SECRET_STORE: 'file',
                TABULARIS_SECRET_KEY: randomBytes(32).toString('hex'),
                TABULARIS_SECRET_STORE_PATH: join(temp, 'secrets.json'),
            },
            cwd: temp,
            detached: true,
            stdio: ['ignore', log.fd, log.fd],
        },
    );
    let ready = false;
    for (let attempt = 0; attempt < 300; attempt++) {
        assert.equal(server.exitCode, null, 'Core exited before web startup');
        try {
            if ((await fetch(`${origin}/login`)).ok) {
                ready = true;
                break;
            }
        } catch {}
        await pause(100);
    }
    assert(ready, 'Core web server failed to start');
    const login = await fetch(`${origin}/api/v1/auth/login`, {
        method: 'POST',
        headers: {origin, 'content-type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({password}),
        redirect: 'manual',
    });
    assert.equal(login.status, 303);
    cookie = login.headers.get('set-cookie').split(';')[0];
    csrf = (await (await fetch(`${origin}/api/v1/session`, {headers: {cookie}})).json()).csrfToken;
    assert(csrf);
    await check(
        'password-authenticated Tabularis web enforces authentication and provider scope',
        async () => {
            const anonymous = await fetch(`${origin}/api/v1/rpc/plugin_account`, {
                method: 'POST',
                headers: {origin, 'content-type': 'application/json'},
                body: JSON.stringify({pluginId: 'neon', operation: 'fields'}),
            });
            assert.equal(anonymous.status, 401);
            await assert.rejects(call('account_import'), /reserved/);
            assert.deepEqual(await account('fields'), []);
        },
    );
    await check(
        'host CLI profile can be reused before any account or database connection exists',
        async () => {
            const status = await account('prepare', {
                method: 'account_cli_status',
                args: {profile: cliProfile},
            });
            assert(
                status.installed && status.canReuse && status.authenticated,
                'Explicit CLI profile has no reusable sign-in',
            );
            assert(!JSON.stringify(status).includes('access_token'));
            assert.deepEqual(await rpc('get_connections'), []);
        },
    );
    browser = await chromium.launch({
        executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable',
        headless: true,
    });
    const context = await browser.newContext({
        viewport: {width: 1440, height: 1000},
        colorScheme: 'dark',
    });
    const separator = cookie.indexOf('=');
    await context.addCookies([
        {
            name: cookie.slice(0, separator),
            value: cookie.slice(separator + 1),
            url: origin,
            httpOnly: true,
            sameSite: 'Strict',
        },
    ]);
    await context.route('**/api/v1/rpc/plugin_account', (route) => {
        const payload = route.request().postDataJSON();
        if (/(?:deploy|delete|rename|create|set_role)/.test(payload.method ?? '')) {
            const permitted =
                process.env.NEON_ACCOUNT_TEST_FUNCTION_WRITES === '1' &&
                ['account_function_deploy', 'account_function_delete'].includes(payload.method) &&
                payload.args?.projectId === projectId &&
                payload.args?.branchId === branchId &&
                payload.args?.slug === ownFunctionSlug;
            if (!permitted) {
                evidence.guardFailure = 'Blocked an unexpected provider mutation before sending it';
                return route.abort('blockedbyclient');
            }
        }
        return route.continue();
    });
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', (error) => evidence.pageErrors.push(error.message));
    page.on('request', (request) => {
        if (new URL(request.url()).pathname !== '/api/v1/rpc/plugin_account') return;
        evidence.accountRequests++;
        const payload = request.postDataJSON();
        if (payload.operation === 'import')
            assert.equal(payload.args.createServiceCredentials, false);
        if (/(?:deploy|delete|rename|create|set_role)/.test(payload.method ?? ''))
            evidence.providerMutations.push(payload.method);
    });
    await page.goto(origin);
    await page.getByRole('button', {name: 'Add Connection', exact: true}).first().click();
    await page.getByRole('button', {name: 'Connect to Neon', exact: true}).click();
    const setup = await guest('.neon-connection-setup');
    await setup.getByText('Connect your Neon workspace', {exact: true}).waitFor();
    await check(
        'real sandbox UI links the explicit host CLI profile without copying a bearer into the browser',
        async () => {
            await setup
                .getByRole('button', {name: 'Use signed-in Neon CLI account', exact: true})
                .waitFor({timeout: 45000});
            const profile = setup.getByLabel('CLI profile', {exact: true});
            if (await profile.count()) await choose(setup, 'CLI profile', cliProfile);
            await setup
                .getByRole('button', {name: 'Use signed-in Neon CLI account', exact: true})
                .click();
            await setup
                .getByText('Neon CLI account connected', {exact: true})
                .waitFor({timeout: 45000});
            assert.deepEqual(await account('fields'), ['NEON_CLI_AUTH']);
            assert.equal(await setup.locator('input[type="password"]').count(), 0);
        },
    );
    let resources;
    let imported;
    await check('Neon resource discovery selects only the explicit disposable branch', async () => {
        const branches = await call('account_branches', {projectId});
        const selected = branches.branches.find((branch) => branch.id === branchId);
        assert(
            selected && selected.name === branchName,
            'Disposable branch ID/name does not match',
        );
        resources = await call('account_resources', {projectId, branchId});
        assert(resources.databases.length && resources.roles.length);
        if (orgId) await choose(setup, 'Organization', orgId);
        await choose(setup, 'Project', projectId);
        await choose(setup, 'Branch', branchId);
        await choose(setup, 'Database', resources.databases[0].name);
        await choose(setup, 'Database role', resources.roles[0].name);
        assert.equal(await setup.getByRole('checkbox').isChecked(), false);
    });
    await check(
        'browser imports the disposable branch without creating or rotating service credentials',
        async () => {
            const importButton = setup.getByRole('button', {
                name: 'Import connection',
                exact: true,
            });
            await expect(importButton).toBeEnabled();
            await setup.getByLabel('Database role', {exact: true}).hover();
            await page.mouse.wheel(0, 1000);
            await expect(importButton).toBeInViewport();
            const response = page.waitForResponse(
                (response) =>
                    response.url().endsWith('/rpc/plugin_account') &&
                    response.request().postDataJSON()?.operation === 'import',
            );
            await importButton.click();
            const result = await (await response).json();
            assert.equal(result.ok, true, result.error?.message);
            imported = result.data;
            connectionId = imported.id;
            assert.deepEqual(Object.keys(imported).sort(), ['id', 'name', 'warnings']);
            await setup.getByRole('button', {name: 'Done', exact: true}).click();
            await page.getByText(imported.name, {exact: true}).waitFor();
            const saved = await rpc('get_connection_by_id', {id: connectionId});
            assert.equal(saved.params.driver, 'neon');
            assert.equal(saved.params.ssl_mode, 'verify-full');
            assert(!saved.params.password && !saved.params.connection_uri);
            const fields = await rpc('get_plugin_secret_fields', {pluginId: 'neon', connectionId});
            assert(fields.includes('NEON_PROJECT_ID') && fields.includes('NEON_BRANCH_ID'));
            assert(
                !fields.includes('NEON_API_KEY') &&
                    !fields.includes('AWS_SECRET_ACCESS_KEY') &&
                    !fields.includes('NEON_AI_GATEWAY_TOKEN'),
            );
            const stored = JSON.parse(
                await readFile(join(config, 'tabularis', 'connections.json'), 'utf8'),
            );
            assert(
                stored.connections.every(
                    (connection) =>
                        !connection.params.password && !connection.params.connection_uri,
                ),
            );
        },
    );
    await check(
        'saved Neon SQL connection executes a read-only query through authenticated web RPC',
        async () => {
            const result = await rpc('execute_query', {
                connectionId,
                query: 'SELECT current_database() AS database, 42::int AS live_web_ok',
                limit: 10,
                page: 1,
            });
            assert.equal(result.rows[0][1], 42);
            assert.equal(result.rows[0][0], resources.databases[0].name);
            await page.getByText(imported.name, {exact: true}).dblclick();
            await page.waitForURL(new RegExp(`/connections/${connectionId}/editor`), {
                timeout: 45000,
            });
        },
    );
    await check(
        'compact explorer branch selector exposes its menu to ordinary pointer input',
        async () => {
            const branchSelector = await guest('[aria-label="Switch Neon branch"]');
            const field = branchSelector.getByRole('combobox', {
                name: 'Switch Neon branch',
                exact: true,
            });
            await expect(field).toBeEnabled({timeout: 45000});
            await field.click();
            const option = branchSelector.locator(
                `[data-plugin-select-menu] [data-value=${JSON.stringify(branchId)}]`,
            );
            await option.hover();
            await expect(option).toBeInViewport();
            await field.press('Escape');
            await page.screenshot({
                path: join(artifacts, 'live-web-compact-selector.png'),
                fullPage: true,
            });
        },
    );
    const explorer = await guest('[aria-pressed]');
    await check(
        'real Overview workspace reads the imported connection in its sandbox',
        async () => {
            await explorer.getByRole('button', {name: 'Overview', exact: true}).click();
            const overview = await guest('.neon-panel .neon-view');
            await overview.getByText(branchName, {exact: true}).first().waitFor();
            await overview.getByText('Connection details', {exact: true}).click();
            await overview.getByText(projectId, {exact: true}).waitFor();
            await page.screenshot({path: join(artifacts, 'live-web-overview.png'), fullPage: true});
        },
    );
    await check(
        'Branches workspace resolves connection-bound provider management through web',
        async () => {
            await explorer.getByRole('button', {name: 'Branches', exact: true}).click();
            const branches = await guest('.neon-branches-layout');
            await branches.getByText(branchName, {exact: true}).first().waitFor({timeout: 45000});
            await expect(
                branches.getByRole('button', {name: 'Open in new connection', exact: true}),
            ).toBeEnabled({timeout: 45000});
            await page.screenshot({path: join(artifacts, 'live-web-branches.png'), fullPage: true});
        },
    );
    await check(
        'Functions workspace lists only the imported branch without invoking or deploying functions',
        async () => {
            await explorer.getByRole('button', {name: 'Functions', exact: true}).click();
            const functions = await guest('.neon-functions');
            await functions
                .getByText(
                    'Deployed functions on this branch. Open a function to edit, configure, invoke or inspect it.',
                    {exact: true},
                )
                .waitFor({timeout: 45000});
            await expect(
                functions.getByRole('button', {name: 'New function', exact: true}),
            ).toBeEnabled();
            await functions
                .getByRole('list', {name: 'Branch functions', exact: true})
                .or(
                    functions.getByText('No functions have been deployed on this branch.', {
                        exact: true,
                    }),
                )
                .waitFor({timeout: 45000});
            assert.equal(await functions.getByRole('alert').count(), 0);
            await pause(1500);
            const previous = evidence.accountRequests;
            await pause(1500);
            assert.equal(evidence.accountRequests, previous, 'Provider hooks did not settle');
            await page.screenshot({
                path: join(artifacts, 'live-web-functions.png'),
                fullPage: true,
            });
        },
    );
    if (process.env.NEON_ACCOUNT_TEST_FUNCTION_WRITES === '1') await liveFunctionUi(explorer);
    await check(
        'disconnect removes provider account access while imported SQL remains usable',
        async () => {
            await account('disconnect');
            assert.deepEqual(await account('fields'), []);
            await assert.rejects(call('account_projects'), /Connect the provider account first/);
            const result = await rpc('execute_query', {
                connectionId,
                query: 'SELECT 43::int AS independent_sql_ok',
                limit: 10,
                page: 1,
            });
            assert.equal(result.rows[0][0], 43);
        },
    );
    assert.deepEqual(evidence.pageErrors, []);
    assert(
        evidence.providerMutations.every(
            (method) =>
                process.env.NEON_ACCOUNT_TEST_FUNCTION_WRITES === '1' &&
                ['account_function_deploy', 'account_function_delete'].includes(method),
        ),
    );
} catch (error) {
    if (page) {
        evidence.frameGeometry = await page
            .locator('iframe[title="Plugin neon"]')
            .evaluateAll((frames) =>
                frames.map((frame) => {
                    const rect = frame.getBoundingClientRect();
                    const owner = frame.parentElement;
                    const style = getComputedStyle(owner);
                    return {
                        rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
                        visibility: style.visibility,
                        clip: style.clipPath,
                        position: style.position,
                        pointer: style.pointerEvents,
                    };
                }),
            )
            .catch(() => []);
        evidence.nativeGeometry = await page
            .getByRole('region', {name: 'Function source', exact: true})
            .evaluateAll((editors) =>
                editors.map((editor) => {
                    const rect = editor.getBoundingClientRect();
                    return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
                }),
            )
            .catch(() => []);
    }
    // Screenshots contain only onboarding/branch metadata and synthetic SQL, never credentials or user rows.
    await page
        ?.screenshot({path: join(artifacts, 'live-web-failure.png'), fullPage: true})
        .catch(() => {});
    evidence.error = error instanceof Error ? error.message : 'Live web integration failed';
    console.error(`FAIL ${evidence.error}`);
    process.exitCode = 1;
} finally {
    await browser?.close();
    if (cookie && csrf) {
        if (ownFunctionCreated) {
            try {
                await functionRequest('account_function_delete');
                evidence.ownFunctionDeleted = true;
            } catch {
                evidence.functionCleanupFailed = true;
                process.exitCode = 1;
            }
        }
        if (connectionId) {
            await rpc('disconnect_connection', {connectionId}).catch(() => {});
            await rpc('delete_connection', {id: connectionId}).catch(() => {});
        }
        await account('disconnect').catch(() => {});
    }
    if (server?.pid) {
        try {
            process.kill(-server.pid, 'SIGTERM');
        } catch {}
        await Promise.race([once(server, 'exit'), pause(2000)]);
        if (server.exitCode === null && server.signalCode === null) {
            try {
                process.kill(-server.pid, 'SIGKILL');
            } catch {}
        }
    }
    await log?.close();
    await mkdir(artifacts, {recursive: true});
    await writeFile(join(artifacts, 'live-web-e2e.json'), JSON.stringify(evidence, null, 2) + '\n');
    await rm(temp, {recursive: true, force: true});
}
