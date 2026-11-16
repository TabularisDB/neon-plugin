import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import {mkdtemp, mkdir, readFile, writeFile, rm, open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';

// This smoke test never links an account, imports a provider connection or contacts Neon.
const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const coreRoot = process.env.TABULARIS_CORE_ROOT && resolve(process.env.TABULARIS_CORE_ROOT);
assert(coreRoot, 'Set TABULARIS_CORE_ROOT to the built provider-sandbox Core checkout');
const requireCore = createRequire(join(coreRoot, 'package.json'));
const {chromium} = requireCore('@playwright/test');
const manifest = JSON.parse(await readFile(join(pluginRoot, '.tabularium'), 'utf8'));
assert(manifest.ui_extensions.every((extension) => extension.api_version === '0.4.1'));
const archive = join(
    pluginRoot,
    `neon-${manifest.version}-${process.platform}-${process.arch}.zip`,
);
const temp = await mkdtemp(join(tmpdir(), 'tabularis-neon-sandbox-'));
const artifacts = join(pluginRoot, 'artifacts');
const evidence = {
    apiVersion: '0.4.1',
    checks: [],
    accountRequests: 0,
    pageErrors: [],
    blockedRemoteRequests: [],
};
let server;
let browser;
let page;
let log;
const check = (name) => {
    evidence.checks.push(name);
    console.log(`PASS ${name}`);
};
const pause = (milliseconds) =>
    new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));

try {
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise((resolveClose) => reservation.close(resolveClose));
    const origin = `http://127.0.0.1:${port}`;
    const home = join(temp, 'home');
    const config = join(temp, 'config');
    const data = join(temp, 'data');
    const bin = join(temp, 'bin');
    const pluginDirectory = join(data, 'tabularis', 'plugins', 'drivers', 'neon');
    for (const directory of [
        home,
        config,
        data,
        bin,
        pluginDirectory,
        join(config, 'tabularis'),
        artifacts,
    ])
        await mkdir(directory, {recursive: true});
    const unpack = spawnSync('unzip', ['-q', archive, '-d', pluginDirectory], {encoding: 'utf8'});
    assert.equal(unpack.status, 0, `Build/package the real plugin first: ${unpack.stderr}`);
    await writeFile(
        join(config, 'tabularis', 'config.json'),
        JSON.stringify({
            activeExternalDrivers: ['neon'],
            language: 'en',
            showWelcome: false,
            checkForUpdates: false,
            autoCheckUpdatesOnStartup: false,
            pingInterval: 0,
            autoConnectLastConnection: false,
            lastOpenConnectionIds: [],
            lastActiveConnectionId: null,
        }),
    );
    const launchFile = join(temp, 'launch-url');
    const opener = join(bin, 'xdg-open');
    await writeFile(opener, '#!/bin/sh\nprintf "%s\\n" "$1" > "$TABULARIS_E2E_LAUNCH_URL_FILE"\n', {
        mode: 0o700,
    });
    const guard = join(temp, 'network-guard.cjs');
    await writeFile(
        guard,
        `globalThis.fetch = async () => { require('node:fs').appendFileSync(${JSON.stringify(join(temp, 'network-attempts'))}, 'blocked\\n'); throw new Error('Offline sandbox smoke test forbids provider network'); };\n`,
    );
    // Explicit environment prevents inherited account keys, profile/config references and keyrings.
    const childEnv = {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: home,
        XDG_CONFIG_HOME: config,
        XDG_DATA_HOME: data,
        XDG_CACHE_HOME: join(temp, 'cache'),
        TMPDIR: temp,
        LANG: 'C.UTF-8',
        NEON_CONFIG_DIR: join(config, 'neon'),
        BROWSER: opener,
        XDG_CURRENT_DESKTOP: 'X-Generic',
        DISPLAY: '',
        WAYLAND_DISPLAY: '',
        TABULARIS_E2E_LAUNCH_URL_FILE: launchFile,
        NODE_OPTIONS: `--require=${guard}`,
        TABULARIS_SECRET_STORE: 'file',
        TABULARIS_SECRET_STORE_PATH: join(temp, 'secrets.json'),
        TABULARIS_SECRET_KEY: '17'.repeat(32),
    };
    log = await open(join(temp, 'server.log'), 'w', 0o600);
    server = spawn(
        join(coreRoot, 'src-tauri/target/debug/tabularis'),
        [
            'web',
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--web-root',
            join(coreRoot, 'packages/web-ui/dist'),
        ],
        {env: childEnv, cwd: temp, detached: true, stdio: ['ignore', log.fd, log.fd]},
    );
    let launchUrl;
    for (let attempt = 0; attempt < 300; attempt++) {
        assert.equal(server.exitCode, null, 'Core exited before bootstrap');
        try {
            launchUrl = (await readFile(launchFile, 'utf8')).trim();
        } catch {}
        if (launchUrl) break;
        await pause(100);
    }
    assert(launchUrl, 'Core did not emit a bootstrap URL');
    assert.equal(new URL(launchUrl).origin, origin);
    browser = await chromium.launch({
        executablePath: process.env.CHROME_PATH,
        headless: true,
        args: ['--no-sandbox', '--disable-background-networking'],
    });
    const context = await browser.newContext({viewport: {width: 1280, height: 900}});
    await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol))
            return route.continue();
        evidence.blockedRemoteRequests.push(url.origin);
        return route.abort();
    });
    page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on('pageerror', (error) => evidence.pageErrors.push(error.message));
    const preparations = [];
    page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/v1/rpc/plugin_account')
            evidence.accountRequests++;
    });
    page.on('response', async (response) => {
        if (new URL(response.url()).pathname !== '/api/v1/rpc/plugin_account') return;
        try {
            const payload = response.request().postDataJSON();
            if (payload.operation === 'prepare')
                preparations.push({request: payload, response: await response.json()});
        } catch {}
    });
    await page.goto(launchUrl);
    await page.getByRole('button', {name: 'Add Connection', exact: true}).first().click();
    await page.getByRole('button', {name: 'Connect to Neon', exact: true}).click();
    const sandbox = page.frameLocator('iframe[title="Plugin neon"]');
    await sandbox.getByText('Connect your Neon workspace', {exact: true}).waitFor();
    await sandbox.getByRole('button', {name: 'Use API key', exact: true}).waitFor();
    check('real Neon API 0.4.1 setup renders inside the isolated plugin iframe');
    for (let attempt = 0; attempt < 150 && !preparations.length; attempt++) await pause(100);
    const status = preparations.find((entry) => entry.request.method === 'account_cli_status');
    assert(status, 'Guest setup never called the real Core account.prepare transport');
    assert.equal(status.response.ok, true, JSON.stringify(status.response));
    assert.equal(status.response.data.authenticated, false);
    assert.equal(status.response.data.canReuse, false);
    evidence.cliStatus = {
        installed: status.response.data.installed,
        version: status.response.data.version,
        authenticated: status.response.data.authenticated,
        canReuse: status.response.data.canReuse,
        reasonCode: status.response.data.reasonCode,
    };
    check('sandbox account.prepare executes CLI status against isolated HOME without an account');
    await sandbox.getByRole('button', {name: 'Use API key', exact: true}).click();
    const key = sandbox.getByLabel('Neon API key', {exact: true});
    await key.waitFor();
    assert.equal(await key.inputValue(), '');
    assert.equal(await key.getAttribute('type'), 'password');
    check('API-key entry is available and empty; no credential was entered or saved');
    await pause(1500);
    const stableCount = evidence.accountRequests;
    await pause(1500);
    assert.equal(
        evidence.accountRequests,
        stableCount,
        'Guest account/translation hooks continuously retrigger RPC',
    );
    assert(stableCount < 12, `Unexpected account RPC volume: ${stableCount}`);
    check('guest hooks settle without repeated account RPCs');
    let linked=0;
    await context.route('**/api/v1/rpc/**',async(route)=>{
        const request=route.request().postDataJSON();
        if(JSON.stringify(request).includes('offline-form-test-key')) {
            linked++;
            await route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'FORBIDDEN',message:'Offline submit reached the host'}})});
        } else await route.continue();
    });
    await key.fill('offline-form-test-key');
    await sandbox.getByRole('button',{name:'Connect account',exact:true}).click();
    for(let attempt=0;attempt<40&&!linked;attempt++)await pause(50);
    assert(linked,'The API-key form did not submit through the allow-scripts-only sandbox');
    await key.fill('offline-form-test-key');
    await key.press('Enter');
    for(let attempt=0;attempt<40&&linked<2;attempt++)await pause(50);
    assert.equal(linked,2,'Keyboard submission must reach the same handler exactly once');
    check('real API-key form submits through the sandbox; synthetic key intercepted before storage/network');
    await page.screenshot({path: join(artifacts, 'sandbox-host-e2e.png'), fullPage: true});
    assert.deepEqual(evidence.pageErrors, []);
    let attempts = '';
    try {
        attempts = await readFile(join(temp, 'network-attempts'), 'utf8');
    } catch {}
    assert.equal(attempts, '', 'Plugin attempted provider networking during offline setup');
    check('no page errors and no plugin provider-network attempts');
} catch (error) {
    await page
        ?.screenshot({path: join(artifacts, 'sandbox-host-e2e-failure.png'), fullPage: true})
        .catch(() => {});
    evidence.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
    console.error(`FAIL ${evidence.error}`);
} finally {
    await browser?.close();
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
    await writeFile(
        join(artifacts, 'sandbox-host-e2e.json'),
        JSON.stringify(evidence, null, 2) + '\n',
    );
    await rm(temp, {recursive: true, force: true});
}
