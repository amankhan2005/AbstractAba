import { useState } from 'react';
import { useAuthStore } from '@/auth/store';
import { PageHeader, Card, Avatar, Badge, Icon, DescriptionList } from '@/components';
import { formatPersonName } from '@/lib/format';
import { ChangePasswordModal } from './ChangePasswordModal';
import { LogoutConfirm } from './LogoutConfirm';

/**
 * My account — the signed-in operator's profile (read-only, from /auth/me),
 * password change and log out. Operator identity is managed by the platform;
 * nothing here edits roles or permissions.
 */
export function AccountRx() {
  const principal = useAuthStore((s) => s.principal);
  const [changing, setChanging] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const user = principal?.user ?? {};
  const name = formatPersonName(user.fullName) || 'Platform administrator';

  return (
    <section>
      <PageHeader eyebrow="System" title="My account" description="Your profile and sign-in security for the Platform Console." />

      <div className="rxc-grid rxc-grid--main">
        <div className="rxc-stack">
          <Card title="Profile" description="Your operator profile is managed by the platform.">
            <div className="rxc-entity" style={{ marginBottom: 18 }}>
              <Avatar name={name} size="lg" />
              <span className="rxc-entity__text">
                <span className="rxc-entity__name" style={{ fontSize: '1.05rem' }}>{name}</span>
                <span className="rxc-entity__sub">{user.email}</span>
              </span>
            </div>
            <DescriptionList items={[
              ['Full name', name],
              ['Email', user.email],
              ['Role', principal?.isPlatformOperator ? 'Platform administrator' : 'Operator'],
              ['Account status', user.status ? <Badge key="s" tone={user.status === 'ACTIVE' ? 'ok' : 'warn'}>{user.status === 'ACTIVE' ? 'Active' : 'Restricted'}</Badge> : ''],
            ]} />
          </Card>
        </div>

        <div className="rxc-stack">
          <Card title="Security">
            <div className="rxc-quick">
              <button type="button" className="rxc-quick__item" onClick={() => setChanging(true)}>
                <span className="rxc-quick__icon rxc-tone--blue"><Icon name="key" size={17} /></span>
                <span className="rxc-quick__text"><span className="rxc-quick__title">Change password</span><span className="rxc-quick__desc">Update the password you use to sign in</span></span>
                <Icon name="chevronRight" size={16} />
              </button>
              <button type="button" className="rxc-quick__item" onClick={() => setLoggingOut(true)}>
                <span className="rxc-quick__icon rxc-tone--red"><Icon name="logout" size={17} /></span>
                <span className="rxc-quick__text"><span className="rxc-quick__title">Log out</span><span className="rxc-quick__desc">End your session on this device</span></span>
                <Icon name="chevronRight" size={16} />
              </button>
            </div>
          </Card>
        </div>
      </div>

      {changing ? <ChangePasswordModal onClose={() => setChanging(false)} /> : null}
      <LogoutConfirm open={loggingOut} onClose={() => setLoggingOut(false)} />
    </section>
  );
}

export default AccountRx;
