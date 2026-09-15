/**
 * Export field ALLOWLISTS. Only fields explicitly listed here are ever written to
 * an organization export. This is a positive allowlist (not a denylist), so new
 * model fields are excluded by default — secrets, password hashes, session
 * tokens, PHI envelopes (client.sensitive), and storage descriptors
 * (storageRef/checksum) can never leak into an export unless deliberately added.
 */

export const EXPORT_ENTITIES = {
  clients: {
    headers: ['id', 'clientNumber', 'firstName', 'lastName', 'status', 'createdAt'],
    map: (d) => ({
      id: d._id,
      clientNumber: d.clientNumber ?? '',
      firstName: d.firstName ?? '',
      lastName: d.lastName ?? '',
      status: d.status ?? '',
      createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : '',
    }),
  },
  staff: {
    headers: ['id', 'employeeNumber', 'firstName', 'lastName', 'discipline', 'status', 'createdAt'],
    map: (d) => ({
      id: d._id,
      employeeNumber: d.employeeNumber ?? '',
      firstName: d.firstName ?? '',
      lastName: d.lastName ?? '',
      discipline: d.discipline ?? '',
      status: d.status ?? '',
      createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : '',
    }),
  },
  authorizations: {
    headers: ['id', 'authorizationNumber', 'payerName', 'serviceCode', 'startDate', 'endDate', 'authorizedUnits', 'status'],
    map: (d) => ({
      id: d._id,
      authorizationNumber: d.authorizationNumber ?? '',
      payerName: d.payerName ?? '',
      serviceCode: d.serviceCode ?? '',
      startDate: d.startDate ? new Date(d.startDate).toISOString().slice(0, 10) : '',
      endDate: d.endDate ? new Date(d.endDate).toISOString().slice(0, 10) : '',
      authorizedUnits: d.authorizedUnits ?? '',
      status: d.status ?? '',
    }),
  },
};

export const EXPORTABLE_ENTITIES = Object.keys(EXPORT_ENTITIES);

// Fields that must NEVER appear in any export mapper (defense-in-depth; asserted
// by tests against every mapper's output).
export const FORBIDDEN_EXPORT_FIELDS = [
  'sensitive', 'ssn', 'passwordHash', 'password', 'tokenHash', 'refreshToken',
  'storageRef', 'checksum', 'mfaSecret', 'secret',
];
