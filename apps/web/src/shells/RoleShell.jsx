import { useAuthStore } from '@/auth/store';
import { CompanyShell } from './CompanyShell.jsx';
import { BcbaShell } from './BcbaShell.jsx';
import { RbtShell } from './RbtShell.jsx';

/**
 * Pure selector: which of the four experiences a set of roles resolves to.
 * Extracted so the dispatch is unit-tested without rendering a router.
 *
 * Precedence follows the blueprint scope ladder (organization > team > self):
 * a user who holds several roles gets the widest experience they own, because
 * that experience contains the narrower ones' work as a subset. A specialist
 * with none of the four primary roles still gets the operator shell so the
 * sections their permissions open are reachable.
 */
export function shellForRoles(roles = []) {
  if (roles.includes('owner') || roles.includes('org_admin')) return 'company';
  if (roles.includes('bcba')) return 'bcba';
  if (roles.includes('rbt')) return 'rbt';
  return 'company';
}

const SHELLS = { company: CompanyShell, bcba: BcbaShell, rbt: RbtShell };

/**
 * Chooses the ROLE-SPECIFIC application shell for the signed-in principal. This
 * is what replaces the single shared WorkspaceLayout: there is no one shell that
 * serves every role — CompanyShell, BcbaShell and RbtShell are independently
 * built experiences with their own brand, nav model, terminology and header.
 */
export function RoleShell() {
  const roles = useAuthStore((s) => s.principal?.roles) ?? [];
  const Shell = SHELLS[shellForRoles(roles)];
  return <Shell />;
}

export default RoleShell;
