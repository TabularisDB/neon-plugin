import {randomUUID} from 'node:crypto';
import type {NeonClient} from '@neon/sdk';
import type {Params} from './database.js';

export const authManagementMethods = new Set([
    'account_auth_sign_in',
    'account_auth_sign_out',
    'account_auth_session_status',
    'account_auth_organizations',
    'account_auth_invitations',
    'account_auth_invite',
    'account_auth_cancel_invitation',
    'account_auth_set_password',
]);
export class AuthManagementError extends Error {}
interface Session {
    owner: string;
    base: string;
    origin: string;
    cookies: Map<string, string>;
    expires: number;
    lease: number;
    fetcher: typeof fetch;
}
const sessions = new Map<string, Session>();
function prune(): void {
    for (const [id, session] of sessions)
        if (session.expires <= Date.now() || session.lease <= Date.now()) {
            sessions.delete(id);
            void request(session, 'sign-out', session.fetcher, {})
                .catch(() => undefined)
                .finally(() => session.cookies.clear());
        }
}
const sweeper = setInterval(prune, 30000);
sweeper.unref();
const string = (value: unknown, label: string, max = 2048): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value))
        throw new AuthManagementError(`Invalid ${label}`);
    return value;
};
const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new AuthManagementError('Neon Auth returned an invalid response');
    return value as Record<string, unknown>;
};

async function endpoint(
    client: NeonClient<true>,
    scope: {projectId: string; branchId: string},
): Promise<string> {
    let integration;
    try {
        integration = await client.auth.get(scope);
    } catch {
        throw new AuthManagementError('The Neon account cannot access this Auth service');
    }
    let url: URL;
    try {
        url = new URL(string(integration.base_url, 'Auth endpoint'));
    } catch {
        throw new AuthManagementError('Neon returned an invalid Auth endpoint');
    }
    if (
        url.protocol !== 'https:' ||
        !url.hostname.endsWith('.neon.tech') ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.port
    )
        throw new AuthManagementError('Neon returned an invalid Auth endpoint');
    return url.href.replace(/\/$/, '');
}

async function request(
    session: Session,
    route: string,
    fetcher: typeof fetch,
    body?: Params,
): Promise<unknown> {
    let response: Response;
    try {
        response = await fetcher(`${session.base}/${route}`, {
            method: body ? 'POST' : 'GET',
            redirect: 'error',
            signal: AbortSignal.timeout(15000),
            headers: {
                origin: session.origin,
                ...(body ? {'content-type': 'application/json'} : {}),
                ...(session.cookies.size
                    ? {cookie: [...session.cookies].map(([k, v]) => `${k}=${v}`).join('; ')}
                    : {}),
            },
            ...(body ? {body: JSON.stringify(body)} : {}),
        });
    } catch {
        throw new AuthManagementError('Neon Auth is unreachable');
    }
    if (!response.ok) {
        await response.body?.cancel();
        throw new AuthManagementError(
            response.status === 401
                ? 'Auth sign-in is required or credentials were rejected'
                : response.status === 403
                  ? 'Auth denied this action; check the user permissions and allowed origin'
                  : 'Neon Auth rejected the request; check the project configuration and input',
        );
    }
    for (const header of response.headers.getSetCookie()) {
        const pair = header.split(';', 1)[0],
            equals = pair.indexOf('=');
        if (equals > 0 && !/[\r\n]/.test(pair)) {
            const name = pair.slice(0, equals),
                value = pair.slice(equals + 1);
            if (!value || /max-age=0\b/i.test(header)) session.cookies.delete(name);
            else session.cookies.set(name, value);
        }
    }
    if ([...session.cookies.values()].reduce((sum, value) => sum + value.length, 0) > 16384)
        throw new AuthManagementError('Neon Auth session is too large');
    if (!response.body) return null;
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > 512 * 1024) {
                await reader.cancel();
                throw new AuthManagementError('Neon Auth response exceeds 512 KiB');
            }
            chunks.push(next.value);
        }
        if (!size) return null;
        try {
            return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
            throw new AuthManagementError('Neon Auth returned an invalid response');
        }
    } finally {
        reader.releaseLock();
    }
}

/** App-user sessions are independent of Neon Console keys; cookies never leave this process. */
export async function manageAuth(
    client: NeonClient<true>,
    method: string,
    args: Params,
    scope: {projectId: string; branchId: string},
    owner: string,
    fetcher: typeof fetch,
): Promise<unknown> {
    if (!owner) throw new AuthManagementError('A linked Neon account is required');
    const identity = JSON.stringify([owner, scope.projectId, scope.branchId]);
    prune();
    if (method === 'account_auth_sign_in') {
        if (sessions.size >= 32)
            throw new AuthManagementError(
                'Too many Auth sessions; sign out of an existing workspace first',
            );
        const base = await endpoint(client, scope);
        const origin = new URL(string(args.origin, 'application origin'));
        if (
            origin.username ||
            origin.password ||
            !(
                origin.protocol === 'https:' ||
                (origin.protocol === 'http:' &&
                    ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
            )
        )
            throw new AuthManagementError('Use HTTPS or a local development origin');
        const session: Session = {
            owner: identity,
            base,
            origin: origin.origin,
            cookies: new Map(),
            expires: Date.now() + 3600000,
            lease: Date.now() + 120000,
            fetcher,
        };
        if (sessions.size >= 32)
            throw new AuthManagementError(
                'Too many Auth sessions; sign out of an existing workspace first',
            );
        const id = randomUUID();
        sessions.set(id, session);
        try {
            const data = record(
                await request(session, 'sign-in/email', fetcher, {
                    email: string(args.email, 'email', 320),
                    password: string(args.password, 'password', 1024),
                    rememberMe: false,
                }),
            );
            const user = record(data.user);
            if (!session.cookies.size)
                throw new AuthManagementError('Neon Auth did not establish a session');
            return {
                sessionId: id,
                email: string(user.email, 'Auth email', 320),
                role: typeof user.role === 'string' ? user.role : 'user',
                expiresAt: new Date(session.expires).toISOString(),
            };
        } catch (error) {
            sessions.delete(id);
            session.cookies.clear();
            throw error;
        }
    }
    const id = typeof args.sessionId === 'string' ? args.sessionId : '';
    const session = sessions.get(id);
    if (!session || session.owner !== identity) {
        if (method === 'account_auth_session_status') return {authenticated: false};
        throw new AuthManagementError('Sign in to this branch’s Auth service first');
    }
    if (method === 'account_auth_sign_out') {
        sessions.delete(id);
        try {
            await request(session, 'sign-out', fetcher, {});
        } finally {
            session.cookies.clear();
        }
        return null;
    }
    if ((await endpoint(client, scope)) !== session.base) {
        sessions.delete(id);
        session.cookies.clear();
        throw new AuthManagementError('The Auth service changed; sign in again');
    }
    session.lease = Date.now() + 120000;
    const payload = await request(session, 'get-session', fetcher);
    if (!payload) {
        sessions.delete(id);
        throw new AuthManagementError('The Auth session expired; sign in again');
    }
    const current = record(payload);
    if (!current.user) {
        sessions.delete(id);
        throw new AuthManagementError('The Auth session expired; sign in again');
    }
    const user = record(current.user);
    if (method === 'account_auth_session_status')
        return {
            authenticated: true,
            email: user.email,
            role: typeof user.role === 'string' ? user.role : 'user',
        };
    if (method === 'account_auth_set_password') {
        if (typeof user.role !== 'string' || !user.role.split(',').includes('admin'))
            throw new AuthManagementError('An Auth administrator is required to reset a password');
        const password = string(args.newPassword, 'new password', 1024);
        if (password.length < 8)
            throw new AuthManagementError('Use a password of at least 8 characters');
        await request(session, 'admin/set-user-password', fetcher, {
            userId: string(args.userId, 'user ID', 128),
            newPassword: password,
        });
        return {updated: true};
    }
    if (method === 'account_auth_organizations') {
        const result = await request(session, 'organization/list', fetcher);
        if (!Array.isArray(result) || result.length > 1000)
            throw new AuthManagementError('Neon Auth returned an invalid organization list');
        return {
            organizations: result.map((value) => {
                const r = record(value);
                return {id: r.id, name: r.name, slug: r.slug};
            }),
        };
    }
    if (method === 'account_auth_invitations') {
        const result = await request(
            session,
            `organization/list-invitations?organizationId=${encodeURIComponent(string(args.organizationId, 'Auth organization', 128))}`,
            fetcher,
        );
        if (!Array.isArray(result) || result.length > 1000)
            throw new AuthManagementError('Neon Auth returned an invalid invitation list');
        return {
            invitations: result.map((value) => {
                const r = record(value);
                return {
                    id: r.id,
                    email: r.email,
                    role: r.role,
                    status: r.status,
                    expiresAt: r.expiresAt,
                };
            }),
        };
    }
    if (method === 'account_auth_invite') {
        if (args.role !== 'member' && args.role !== 'admin')
            throw new AuthManagementError('Invitation role must be member or admin');
        const result = record(
            await request(session, 'organization/invite-member', fetcher, {
                organizationId: string(args.organizationId, 'Auth organization', 128),
                email: string(args.email, 'email', 320),
                role: args.role,
            }),
        );
        return {id: result.id, email: result.email, status: result.status};
    }
    if (method === 'account_auth_cancel_invitation') {
        await request(session, 'organization/cancel-invitation', fetcher, {
            invitationId: string(args.invitationId, 'invitation', 128),
        });
        return null;
    }
    throw new AuthManagementError('Unsupported Auth operation');
}

process.stdin.once('end', () => sessions.clear());
