import { useAuthStore } from '@/auth/store';
import { shellForRoles } from '@/shells/RoleShell.jsx';
import { ClientDetailRedesign } from './ClientDetailRedesign.jsx';
import { BcbaChildView } from './BcbaChildView.jsx';
import { RbtChildView } from './RbtChildView.jsx';

/**
 * One child, three genuinely different experiences — chosen by the SAME role
 * selector the shells use, so routing stays consistent with the rest of the app
 * (blueprint Part 13: Company → child editor, BCBA → clinical view, RBT →
 * execution view). No duplicated domain logic: each view reuses the shared
 * getClient/plans/sessions APIs and low-level panels; the backend already shapes
 * the payload per role (v13 field-level serialization), so each view simply
 * renders the data its role is allowed to receive.
 */
export function RoleAwareChildDetail() {
  const roles = useAuthStore((s) => s.principal?.roles) ?? [];
  const experience = shellForRoles(roles);
  if (experience === 'bcba') return <BcbaChildView />;
  if (experience === 'rbt') return <RbtChildView />;
  return <ClientDetailRedesign />; // Company / operator
}

export default RoleAwareChildDetail;
