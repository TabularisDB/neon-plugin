import {useEffect, useId, useRef, useState} from 'react';
import {PluginSelect, usePluginTranslation} from '@tabularis/plugin-api';
import {useNeonManagement} from '../hooks/useNeonManagement';
import {useTask} from '../hooks/useTask';
import {PanelSection} from './PanelSection';

interface Session {
    sessionId: string;
    email: string;
    role: string;
    expiresAt: string;
}
interface Invitation {
    id: string;
    email: string;
    role: string;
    status: string;
    expiresAt: string;
}

export function AuthControl({connectionId, userId}: {connectionId: string; userId?: string}) {
    const t = usePluginTranslation('neon');
    const management = useNeonManagement(connectionId);
    const login = useTask<Session>();
    const action = useTask<{message: string}>();
    const organizations = useTask<{organizations: {id: string; name: string}[]}>();
    const invitations = useTask<{invitations: Invitation[]}>();
    const [session, setSession] = useState<Session>();
    const [sessionError, setSessionError] = useState<string>();
    const [email, setEmail] = useState(''),
        [password, setPassword] = useState(''),
        [origin, setOrigin] = useState('');
    const [organizationId, setOrganizationId] = useState('');
    const [inviteEmail, setInviteEmail] = useState(''),
        [role, setRole] = useState('member');
    const [newPassword, setNewPassword] = useState(''),
        [confirmPassword, setConfirmPassword] = useState('');
    const mounted = useRef(true),
        id = useId();
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    const sessionId = session?.sessionId;
    useEffect(
        () => () => {
            if (sessionId)
                void management.call('account_auth_sign_out', {sessionId}).catch(() => undefined);
        },
        [management.call, sessionId],
    );
    useEffect(() => {
        if (!sessionId) return;
        let disposed = false;
        const timer = setInterval(() => {
            void management
                .call<{authenticated: boolean; email?: string; role?: string}>(
                    'account_auth_session_status',
                    {sessionId},
                )
                .then((status) => {
                    if (disposed) return;
                    if (!status.authenticated) {
                        setSession(undefined);
                        setSessionError(t('authControl.expired'));
                    } else
                        setSession((value) =>
                            value?.sessionId === sessionId
                                ? {
                                      ...value,
                                      email: status.email ?? value.email,
                                      role: status.role ?? value.role,
                                  }
                                : value,
                        );
                })
                .catch(() => undefined);
        }, 30000);
        return () => {
            disposed = true;
            clearInterval(timer);
        };
    }, [management.call, sessionId, t]);
    const authCall = <T,>(method: string, args: Record<string, unknown> = {}) =>
        management.call<T>(method, {...args, sessionId: session?.sessionId});
    const listInvites = (selected = organizationId) =>
        invitations.run(() => authCall('account_auth_invitations', {organizationId: selected}));
    const pending = login.pending || action.pending;
    return (
        <PanelSection title={t('authControl.title')} hint={t('authControl.hint')}>
            {!management.scope && <p className="neon-hint">{t('authControl.accountRequired')}</p>}
            {!session ? (
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        setSessionError(undefined);
                        void login
                            .run(async () => {
                                const result = await management.call<Session>(
                                    'account_auth_sign_in',
                                    {email, password, origin},
                                );
                                if (!mounted.current)
                                    void management
                                        .call('account_auth_sign_out', {
                                            sessionId: result.sessionId,
                                        })
                                        .catch(() => undefined);
                                return result;
                            })
                            .then((result) => {
                                if (result) {
                                    setSession(result);
                                    setPassword('');
                                    setOrganizationId('');
                                    setInviteEmail('');
                                    setRole('member');
                                    void organizations.run(() =>
                                        management.call('account_auth_organizations', {
                                            sessionId: result.sessionId,
                                        }),
                                    );
                                }
                            })
                            .finally(() => {
                                if (mounted.current) setPassword('');
                            });
                    }}
                >
                    <label className="neon-field-label" htmlFor={`${id}-origin`}>
                        {t('authControl.origin')}
                    </label>
                    <input
                        id={`${id}-origin`}
                        className="neon-field"
                        type="url"
                        required
                        value={origin}
                        disabled={pending || !management.scope}
                        onChange={(e) => setOrigin(e.target.value)}
                        placeholder="https://app.example.com"
                    />
                    <p className="neon-hint">{t('authControl.originHint')}</p>
                    <div className="neon-columns">
                        <label className="neon-field-label" htmlFor={`${id}-email`}>
                            {t('authControl.email')}
                            <input
                                id={`${id}-email`}
                                className="neon-field"
                                type="email"
                                autoComplete="username"
                                maxLength={320}
                                required
                                value={email}
                                disabled={pending || !management.scope}
                                onChange={(e) => setEmail(e.target.value)}
                            />
                        </label>
                        <label className="neon-field-label" htmlFor={`${id}-password`}>
                            {t('authControl.password')}
                            <input
                                id={`${id}-password`}
                                className="neon-field"
                                type="password"
                                autoComplete="current-password"
                                maxLength={1024}
                                required
                                value={password}
                                disabled={pending || !management.scope}
                                onChange={(e) => setPassword(e.target.value)}
                            />
                        </label>
                    </div>
                    <button className="neon-button" disabled={pending || !management.scope}>
                        {t('authControl.signIn')}
                    </button>
                    {login.error && (
                        <p role="alert" className="neon-error">
                            {login.error}
                        </p>
                    )}
                    {sessionError && (
                        <p role="alert" className="neon-error">
                            {sessionError}
                        </p>
                    )}
                </form>
            ) : (
                <>
                    <div className="neon-actionbar">
                        <p className="neon-hint">
                            {session.email} · {session.role}
                        </p>
                        <button
                            className="neon-button"
                            disabled={pending}
                            onClick={() =>
                                void action.run(async () => {
                                    try {
                                        await authCall('account_auth_sign_out');
                                    } finally {
                                        setSession(undefined);
                                        setNewPassword('');
                                        setConfirmPassword('');
                                        setOrganizationId('');
                                        setInviteEmail('');
                                        setRole('member');
                                    }
                                    return {message: t('authControl.signedOut')};
                                })
                            }
                        >
                            {t('authControl.signOut')}
                        </button>
                    </div>
                    {userId ? (
                        <form
                            onSubmit={(event) => {
                                event.preventDefault();
                                if (newPassword !== confirmPassword) return;
                                void action
                                    .run(async () => {
                                        await authCall('account_auth_set_password', {
                                            userId,
                                            newPassword,
                                        });
                                        return {message: t('authControl.passwordUpdated')};
                                    })
                                    .finally(() => {
                                        if (mounted.current) {
                                            setNewPassword('');
                                            setConfirmPassword('');
                                        }
                                    });
                            }}
                        >
                            <p className="neon-hint">{t('authControl.resetFor', {userId})}</p>
                            <label className="neon-field-label" htmlFor={`${id}-new`}>
                                {t('authControl.newPassword')}
                            </label>
                            <input
                                id={`${id}-new`}
                                className="neon-field"
                                type="password"
                                autoComplete="new-password"
                                minLength={8}
                                maxLength={1024}
                                required
                                value={newPassword}
                                disabled={pending || !session.role.split(',').includes('admin')}
                                onChange={(e) => setNewPassword(e.target.value)}
                            />
                            <label className="neon-field-label" htmlFor={`${id}-confirm`}>
                                {t('authControl.confirmPassword')}
                            </label>
                            <input
                                id={`${id}-confirm`}
                                className="neon-field"
                                type="password"
                                autoComplete="new-password"
                                minLength={8}
                                maxLength={1024}
                                required
                                value={confirmPassword}
                                disabled={pending || !session.role.split(',').includes('admin')}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                            />
                            <button
                                className="neon-button"
                                disabled={
                                    pending ||
                                    newPassword.length < 8 ||
                                    newPassword !== confirmPassword ||
                                    !session.role.split(',').includes('admin')
                                }
                            >
                                {t('authControl.reset')}
                            </button>
                        </form>
                    ) : (
                        <>
                            <label className="neon-field-label" htmlFor={`${id}-org`}>
                                {t('authControl.organization')}
                            </label>
                            <PluginSelect
                                id={`${id}-org`}
                                value={organizationId}
                                options={(organizations.data?.organizations ?? []).map((org) => ({
                                    value: org.id,
                                    label: org.name,
                                }))}
                                placeholder={t('authControl.chooseOrganization')}
                                disabled={pending || organizations.pending}
                                onChange={(value) => {
                                    setOrganizationId(value);
                                    if (value) void listInvites(value);
                                }}
                            />
                            <button
                                className="neon-button"
                                disabled={organizations.pending}
                                onClick={() =>
                                    void organizations.run(() =>
                                        authCall('account_auth_organizations'),
                                    )
                                }
                            >
                                {t('authControl.refresh')}
                            </button>
                            {organizations.error && (
                                <p role="alert" className="neon-error">
                                    {organizations.error}
                                </p>
                            )}
                            {organizationId && (
                                <>
                                    <form
                                        onSubmit={(event) => {
                                            event.preventDefault();
                                            void action.run(async () => {
                                                await authCall('account_auth_invite', {
                                                    organizationId,
                                                    email: inviteEmail,
                                                    role,
                                                });
                                                setInviteEmail('');
                                                await listInvites();
                                                return {message: t('authControl.invited')};
                                            });
                                        }}
                                    >
                                        <label
                                            className="neon-field-label"
                                            htmlFor={`${id}-invite`}
                                        >
                                            {t('authControl.inviteEmail')}
                                        </label>
                                        <input
                                            id={`${id}-invite`}
                                            className="neon-field"
                                            type="email"
                                            required
                                            maxLength={320}
                                            value={inviteEmail}
                                            disabled={pending}
                                            onChange={(e) => setInviteEmail(e.target.value)}
                                        />
                                        <label className="neon-field-label" htmlFor={`${id}-role`}>
                                            {t('authControl.role')}
                                        </label>
                                        <PluginSelect
                                            id={`${id}-role`}
                                            value={role}
                                            options={[
                                                {value: 'member', label: t('authControl.member')},
                                                {value: 'admin', label: t('authControl.admin')},
                                            ]}
                                            disabled={pending}
                                            onChange={setRole}
                                        />
                                        <p className="neon-hint">{t('authControl.emailHint')}</p>
                                        <button className="neon-button" disabled={pending}>
                                            {t('authControl.invite')}
                                        </button>
                                    </form>
                                    <h3>{t('authControl.invitations')}</h3>
                                    <button
                                        className="neon-button"
                                        disabled={invitations.pending || pending}
                                        onClick={() => void listInvites()}
                                    >
                                        {t('authControl.refresh')}
                                    </button>
                                    <ul>
                                        {invitations.data?.invitations.map((invite) => (
                                            <li key={invite.id}>
                                                {invite.email} · {invite.role} · {invite.status}
                                                {invite.status === 'pending' && (
                                                    <button
                                                        className="neon-button"
                                                        disabled={pending}
                                                        aria-label={t('authControl.cancelFor', {
                                                            email: invite.email,
                                                        })}
                                                        onClick={() =>
                                                            void action.run(async () => {
                                                                await authCall(
                                                                    'account_auth_cancel_invitation',
                                                                    {invitationId: invite.id},
                                                                );
                                                                await listInvites();
                                                                return {
                                                                    message:
                                                                        t('authControl.cancelled'),
                                                                };
                                                            })
                                                        }
                                                    >
                                                        {t('authControl.cancel')}
                                                    </button>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                    {invitations.error && (
                                        <p role="alert" className="neon-error">
                                            {invitations.error}
                                        </p>
                                    )}
                                </>
                            )}
                        </>
                    )}
                    {action.error && (
                        <p role="alert" className="neon-error">
                            {action.error}
                        </p>
                    )}
                    {action.data && (
                        <p role="status" className="neon-hint">
                            {action.data.message}
                        </p>
                    )}
                </>
            )}
        </PanelSection>
    );
}
