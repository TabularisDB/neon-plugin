// @vitest-environment jsdom
import {createElement} from 'react';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {AuthControl} from '../../src/components/AuthControl';
const management = vi.hoisted(() => ({
    scope: {projectId: 'project', branchId: 'branch'},
    pending: false,
    call: vi.fn(),
}));
vi.mock('../../src/hooks/useNeonManagement', () => ({useNeonManagement: () => management}));
vi.mock('@tabularis/plugin-api', () => ({
    usePluginTranslation: () => (key: string) => key,
    PluginSelect: ({
        id,
        value,
        options,
        onChange,
        placeholder,
    }: {
        id: string;
        value: string;
        options: {value: string; label: string}[];
        onChange: (v: string) => void;
        placeholder?: string;
    }) =>
        createElement(
            'select',
            {id, value, onChange: (e: {target: {value: string}}) => onChange(e.target.value)},
            createElement('option', {value: ''}, placeholder),
            ...options.map((o) => createElement('option', {key: o.value, value: o.value}, o.label)),
        ),
}));
beforeEach(() => {
    management.call.mockReset();
    management.call.mockImplementation(async (method) =>
        method === 'account_auth_sign_in'
            ? {
                  sessionId: 'session',
                  email: 'admin@example.com',
                  role: 'admin',
                  expiresAt: '2030-01-01',
              }
            : method === 'account_auth_organizations'
              ? {organizations: [{id: 'org', name: 'Our app'}]}
              : method === 'account_auth_invitations'
                ? {invitations: []}
                : {},
    );
});
afterEach(cleanup);
async function login() {
    fireEvent.change(screen.getByLabelText('authControl.origin'), {
        target: {value: 'https://app.example.com'},
    });
    fireEvent.change(screen.getByLabelText('authControl.email'), {
        target: {value: 'admin@example.com'},
    });
    fireEvent.change(screen.getByLabelText('authControl.password'), {
        target: {value: 'dummy-password'},
    });
    fireEvent.click(screen.getByText('authControl.signIn'));
    await screen.findByText('authControl.signOut');
}
it('creates an invitation in the selected Auth organization and discards state on sign-out', async () => {
    render(createElement(AuthControl, {connectionId: 'connection'}));
    await login();
    await screen.findByText('Our app');
    fireEvent.change(screen.getByLabelText('authControl.organization'), {target: {value: 'org'}});
    fireEvent.change(screen.getByLabelText('authControl.inviteEmail'), {
        target: {value: 'guest@example.com'},
    });
    fireEvent.click(screen.getByText('authControl.invite'));
    await screen.findByText('authControl.invited');
    expect(management.call).toHaveBeenCalledWith('account_auth_invite', {
        sessionId: 'session',
        organizationId: 'org',
        email: 'guest@example.com',
        role: 'member',
    });
    fireEvent.click(screen.getByText('authControl.signOut'));
    await screen.findByText('authControl.signIn');
    expect(screen.queryByText('Our app')).toBeNull();
    expect((screen.getByLabelText('authControl.password') as HTMLInputElement).value).toBe('');
});
it('requires matching passwords for the selected user and clears them after reset', async () => {
    render(createElement(AuthControl, {connectionId: 'connection', userId: 'user-id'}));
    await login();
    fireEvent.change(screen.getByLabelText('authControl.newPassword'), {
        target: {value: 'new-password'},
    });
    fireEvent.change(screen.getByLabelText('authControl.confirmPassword'), {
        target: {value: 'different-password'},
    });
    expect(
        (screen.getByRole('button', {name: 'authControl.reset'}) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText('authControl.confirmPassword'), {
        target: {value: 'new-password'},
    });
    fireEvent.click(screen.getByText('authControl.reset'));
    await screen.findByText('authControl.passwordUpdated');
    expect(management.call).toHaveBeenCalledWith('account_auth_set_password', {
        sessionId: 'session',
        userId: 'user-id',
        newPassword: 'new-password',
    });
    await waitFor(() =>
        expect((screen.getByLabelText('authControl.newPassword') as HTMLInputElement).value).toBe(
            '',
        ),
    );
});
