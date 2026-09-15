import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  activateOrganization,
  beginOffboarding,
  createOrganization,
  fetchAgreements,
  fetchHealth,
  fetchLatestExport,
  fetchOnboarding,
  fetchTenant,
  fetchTenantAudit,
  fetchTenants,
  fetchAllTenants,
  listPlans,
  inviteOwner,
  listMembers,
  provisionOrganization,
  resendInvitation,
  transitionOrganization,
  verifyTenantAudit,
  inviteCompany,
  listCompanyInvitations,
  resendCompanyInvitation,
  revokeCompanyInvitation,
  listInsuranceCatalog,
  createInsuranceCatalog,
  updateInsuranceCatalog,
  deleteInsuranceCatalog,
  uploadInsuranceCatalogLogo,
  listInquiries,
  updateInquiry,
} from './client';

// ---------------- READ QUERIES ----------------

export function useHealth() {
  return useQuery({ queryKey: ['health'], queryFn: fetchHealth });
}

export function useTenants(params = {}) {
  return useQuery({ queryKey: ['tenants', params], queryFn: () => fetchTenants(params) });
}

/** Every company (all cursor pages) — for the directory and dashboard counts. */
export function useAllTenants() {
  return useQuery({ queryKey: ['tenants', { all: true }], queryFn: () => fetchAllTenants() });
}

export function useTenant(id) {
  return useQuery({ queryKey: ['tenant', id], queryFn: () => fetchTenant(id), enabled: id !== '' });
}

export function useTenantAudit(id) {
  return useQuery({ queryKey: ['tenant-audit', id], queryFn: () => fetchTenantAudit(id), enabled: id !== '' });
}

export function useTenantAuditVerification(id) {
  return useQuery({ queryKey: ['tenant-audit-verify', id], queryFn: () => verifyTenantAudit(id), enabled: id !== '' });
}

export function useMembers(id) {
  return useQuery({ queryKey: ['tenant-members', id], queryFn: () => listMembers(id), enabled: id !== '' });
}

export function useOnboarding(id) {
  return useQuery({ queryKey: ['tenant-onboarding', id], queryFn: () => fetchOnboarding(id), enabled: id !== '' });
}

export function useAgreements(id) {
  return useQuery({ queryKey: ['tenant-agreements', id], queryFn: () => fetchAgreements(id), enabled: id !== '' });
}

export function useLatestExport(id, enabled) {
  return useQuery({
    queryKey: ['tenant-export', id],
    queryFn: () => fetchLatestExport(id),
    enabled: id !== '' && !!enabled,
  });
}

// ---------------- MUTATIONS ----------------
// Each mutation invalidates the queries whose data it changes, so the UI
// reflects the new state without a manual refresh.

export function useCreateOrganization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload) => createOrganization(payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenants'] }),
  });
}

export function useTransitionOrganization(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ toState, reason, version }) => transitionOrganization(id, { toState, reason }, version),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenant', id] });
      qc.invalidateQueries({ queryKey: ['tenants'] });
    },
  });
}

export function useInviteOwner(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload) => inviteOwner(id, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenant-members', id] }),
  });
}

export function useResendInvitation(id) {
  return useMutation({ mutationFn: (invitationId) => resendInvitation(id, invitationId) });
}

export function useProvisionOrganization(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => provisionOrganization(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenant', id] });
      qc.invalidateQueries({ queryKey: ['tenant-onboarding', id] });
    },
  });
}

export function useActivateOrganization(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (version) => activateOrganization(id, version),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenant', id] });
      qc.invalidateQueries({ queryKey: ['tenant-onboarding', id] });
      qc.invalidateQueries({ queryKey: ['tenants'] });
    },
  });
}

export function useBeginOffboarding(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ reason, version }) => beginOffboarding(id, { reason }, version),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenant', id] });
      qc.invalidateQueries({ queryKey: ['tenants'] });
    },
  });
}

// ---------------- COMPANY INVITATIONS ----------------

export function useCompanyInvitations(params = {}) {
  return useQuery({ queryKey: ['company-invitations', params], queryFn: () => listCompanyInvitations(params) });
}

export function useInviteCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload) => inviteCompany(payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['company-invitations'] }),
  });
}

export function useResendCompanyInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => resendCompanyInvitation(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['company-invitations'] }),
  });
}

export function useRevokeCompanyInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => revokeCompanyInvitation(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['company-invitations'] }),
  });
}

export function usePlans() {
  return useQuery({ queryKey: ['plans', { active: true }], queryFn: () => listPlans({ activeOnly: true }) });
}

// Full catalogue (active + archived) — used to resolve a company's assigned
// plan code to its display name even when the plan has since been archived.
export function usePlansCatalog() {
  return useQuery({ queryKey: ['plans', { active: false }], queryFn: () => listPlans({ activeOnly: false }) });
}

// ---------------- INSURANCE CATALOG (Module 5) ----------------

export function useInsuranceCatalog() {
  return useQuery({ queryKey: ['insurance-catalog'], queryFn: () => listInsuranceCatalog({}) });
}
export function useCreateInsuranceCatalog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) => createInsuranceCatalog(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['insurance-catalog'] }),
  });
}
export function useUpdateInsuranceCatalog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }) => updateInsuranceCatalog(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['insurance-catalog'] }),
  });
}
export function useUploadInsuranceCatalogLogo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, file }) => uploadInsuranceCatalogLogo(id, file),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['insurance-catalog'] }),
  });
}
export function useDeleteInsuranceCatalog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => deleteInsuranceCatalog(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['insurance-catalog'] }),
  });
}

// ---------------- WEBSITE INQUIRIES ----------------

export function useInquiries() {
  return useQuery({ queryKey: ['inquiries'], queryFn: () => listInquiries({}) });
}
export function useUpdateInquiry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }) => updateInquiry(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inquiries'] }),
  });
}
