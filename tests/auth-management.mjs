import {test} from 'node:test';
import assert from 'node:assert/strict';
import {manageAuth} from '../dist/authManagement.js';

const scope = {projectId: 'project', branchId: 'branch'};
function fixture() {
    const calls = [];
    let role = 'admin',
        expired = false,
        reject = false;
    const client = {
        auth: {
            get: async (params) => {
                assert.deepEqual(params, scope);
                return {base_url: 'https://ep-example.neonauth.aws.neon.tech/neondb/auth'};
            },
        },
    };
    const fetcher = async (url, options) => {
        assert(url.startsWith('https://ep-example.neonauth.aws.neon.tech/neondb/auth/'));
        assert.equal(options.headers.authorization, undefined);
        assert.equal(options.redirect, 'error');
        const route = url.split('/auth/')[1],
            body = options.body ? JSON.parse(options.body) : undefined;
        calls.push({route, options, body});
        if (reject)
            return Response.json({message: 'dummy-provider-cookie dummy-password'}, {status: 403});
        if (route === 'sign-in/email')
            return Response.json(
                {user: {email: body.email, role}, token: 'dummy-provider-cookie'},
                {
                    headers: {
                        'set-cookie':
                            'neon.session_token=dummy-provider-cookie; HttpOnly; Secure; Path=/',
                    },
                },
            );
        assert.equal(options.headers.cookie, 'neon.session_token=dummy-provider-cookie');
        if (route === 'get-session')
            return Response.json(expired ? null : {user: {email: 'admin@example.com', role}});
        if (route === 'organization/list')
            return Response.json([
                {id: 'org', name: 'App organization', slug: 'app', private: 'not-public'},
            ]);
        if (route.startsWith('organization/list-invitations'))
            return Response.json([
                {
                    id: 'inv',
                    email: 'guest@example.com',
                    role: 'member',
                    status: 'pending',
                    expiresAt: '2030-01-01',
                    private: 'not-public',
                },
            ]);
        if (route === 'organization/invite-member')
            return Response.json({
                id: 'inv',
                email: body.email,
                status: 'pending',
                private: 'not-public',
            });
        return Response.json({success: true});
    };
    const call = (method, args = {}, owner = 'owner', selected = scope) =>
        manageAuth(client, method, args, selected, owner, fetcher);
    const login = () =>
        call('account_auth_sign_in', {
            origin: 'https://app.example.com',
            email: 'admin@example.com',
            password: 'dummy-password',
        });
    return {
        client,
        fetcher,
        call,
        login,
        calls,
        setRole(value) {
            role = value;
        },
        expire() {
            expired = true;
        },
        reject() {
            reject = true;
        },
    };
}

test('Auth retains cookies privately and scopes every session to an account and branch', async () => {
    const f = fixture();
    const session = await f.login();
    try {
        assert.equal(session.email, 'admin@example.com');
        assert(!JSON.stringify(session).includes('dummy-'));
        assert.deepEqual(
            await f.call('account_auth_session_status', {sessionId: session.sessionId}),
            {authenticated: true, email: 'admin@example.com', role: 'admin'},
        );
        await assert.rejects(
            f.call(
                'account_auth_set_password',
                {sessionId: session.sessionId, userId: 'u', newPassword: 'new-password'},
                'other',
            ),
            /Sign in/,
        );
        await assert.rejects(
            f.call('account_auth_organizations', {sessionId: session.sessionId}, 'owner', {
                ...scope,
                branchId: 'other',
            }),
            /Sign in/,
        );
        assert.equal(f.calls.filter((c) => c.route === 'admin/set-user-password').length, 0);
    } finally {
        await f.call('account_auth_sign_out', {sessionId: session.sessionId});
    }
    assert.deepEqual(await f.call('account_auth_session_status', {sessionId: session.sessionId}), {
        authenticated: false,
    });
});

test('Auth organization invitations preserve the chosen organization and return only public fields', async () => {
    const f = fixture();
    const {sessionId} = await f.login();
    try {
        const orgs = await f.call('account_auth_organizations', {sessionId});
        assert.deepEqual(orgs, {
            organizations: [{id: 'org', name: 'App organization', slug: 'app'}],
        });
        const created = await f.call('account_auth_invite', {
            sessionId,
            organizationId: 'org',
            email: 'guest@example.com',
            role: 'member',
        });
        assert.deepEqual(created, {id: 'inv', email: 'guest@example.com', status: 'pending'});
        assert.deepEqual(f.calls.find((c) => c.route === 'organization/invite-member').body, {
            organizationId: 'org',
            email: 'guest@example.com',
            role: 'member',
        });
        const list = await f.call('account_auth_invitations', {sessionId, organizationId: 'org'});
        assert(!JSON.stringify(list).includes('not-public'));
        assert(f.calls.some((c) => c.route === 'organization/list-invitations?organizationId=org'));
        await f.call('account_auth_cancel_invitation', {sessionId, invitationId: 'inv'});
        assert.deepEqual(f.calls.find((c) => c.route === 'organization/cancel-invitation').body, {
            invitationId: 'inv',
        });
        await assert.rejects(
            f.call('account_auth_invite', {
                sessionId,
                organizationId: 'org',
                email: 'guest@example.com',
                role: 'owner',
            }),
            /member or admin/,
        );
    } finally {
        await f.call('account_auth_sign_out', {sessionId});
    }
});

test('Auth password reset checks current admin permissions and never returns the password', async () => {
    const f = fixture();
    const {sessionId} = await f.login();
    try {
        assert.deepEqual(
            await f.call('account_auth_set_password', {
                sessionId,
                userId: 'u',
                newPassword: 'new-password',
            }),
            {updated: true},
        );
        assert.deepEqual(f.calls.find((c) => c.route === 'admin/set-user-password').body, {
            userId: 'u',
            newPassword: 'new-password',
        });
        f.setRole('user');
        await assert.rejects(
            f.call('account_auth_set_password', {
                sessionId,
                userId: 'u',
                newPassword: 'new-password',
            }),
            /administrator/,
        );
        assert.equal(f.calls.filter((c) => c.route === 'admin/set-user-password').length, 1);
    } finally {
        await f.call('account_auth_sign_out', {sessionId});
    }
});

test('Auth fails closed on expired sessions and does not echo remote errors or credentials', async () => {
    const f = fixture();
    const {sessionId} = await f.login();
    f.expire();
    await assert.rejects(f.call('account_auth_organizations', {sessionId}), /expired/);
    assert.deepEqual(await f.call('account_auth_session_status', {sessionId}), {
        authenticated: false,
    });
    const other = fixture();
    other.reject();
    await assert.rejects(
        other.login(),
        (error) => !error.message.includes('dummy-') && /denied/.test(error.message),
    );
});

test('Auth refuses external service endpoints and insecure application origins before sending credentials', async () => {
    const f = fixture();
    f.client.auth.get = async () => ({base_url: 'https://attacker.example/auth'});
    await assert.rejects(f.login(), /invalid Auth endpoint/);
    assert.equal(f.calls.length, 0);
    const other = fixture();
    await assert.rejects(
        other.call('account_auth_sign_in', {
            origin: 'http://app.example.com',
            email: 'admin@example.com',
            password: 'dummy-password',
        }),
        /HTTPS/,
    );
    assert.equal(other.calls.length, 0);
});

test('Auth reclaims abandoned workspace leases and signs the provider session out', async (t) => {
    t.mock.timers.enable({apis: ['Date'], now: Date.now()});
    const f = fixture();
    const {sessionId} = await f.login();
    t.mock.timers.tick(120001);
    assert.deepEqual(await f.call('account_auth_session_status', {sessionId}), {
        authenticated: false,
    });
    await new Promise(setImmediate);
    assert(f.calls.some((c) => c.route === 'sign-out'));
});

test('Auth mutations recheck the linked Neon account access before using the app session', async () => {
    const f = fixture();
    const {sessionId} = await f.login();
    f.client.auth.get = async () => {
        throw new Error('revoked API key');
    };
    try {
        await assert.rejects(
            f.call('account_auth_set_password', {
                sessionId,
                userId: 'u',
                newPassword: 'new-password',
            }),
            /cannot access/,
        );
        assert(!f.calls.some((c) => c.route === 'admin/set-user-password'));
    } finally {
        await f.call('account_auth_sign_out', {sessionId});
    }
});
