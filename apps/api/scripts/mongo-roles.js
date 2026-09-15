/**
 * ---------------------------------------------------------------------------
 * MongoDB role setup — the deployment half of the append-only guarantee, the
 * analogue of PostgreSQL's `REVOKE UPDATE, DELETE ... FROM app_runtime`.
 *
 * PostgreSQL made the audit log append-only by GRANTing the application role
 * only what it needed and REVOKing UPDATE/DELETE on the immutable tables. Do the
 * same here: the role the API authenticates with is granted `find` + `insert`
 * on the append-only collections and NOT `update`/`remove`, so an ORM bug or a
 * compromised app process cannot rewrite history. The hash chain then makes any
 * out-of-band tampering detectable.
 *
 * Run once against the admin database as a DB administrator:
 *   mongosh "<admin-uri>" scripts/mongo-roles.js
 * ---------------------------------------------------------------------------
 */
const dbName = 'aba1on1';
const appUser = 'aba1on1_app';
const appPassword = 'CHANGE_ME_STRONG';

const appDb = db.getSiblingDB(dbName);

// Collections that must be append-only for the application role.
const appendOnly = ['audit_record', 'organization_state_transition', 'usage_event', 'organization_tombstone'];
// Everything else the app may read and write.
const readWriteCollections = [
  'organization', 'user', 'user_preference', 'auth_session', 'mfa_factor',
  'password_reset_token', 'job', 'notification', 'notification_delivery',
  'notification_preference', 'membership', 'role', 'membership_role',
  'user_invitation', 'organization_setting', 'organization_agreement',
  'provisioning_step', 'organization_export',
];

appDb.createRole({
  role: 'aba1on1_app_role',
  privileges: [
    ...appendOnly.map((c) => ({
      resource: { db: dbName, collection: c },
      actions: ['find', 'insert'], // NO update, NO remove — the REVOKE analog
    })),
    ...readWriteCollections.map((c) => ({
      resource: { db: dbName, collection: c },
      actions: ['find', 'insert', 'update', 'remove'],
    })),
  ],
  roles: [],
});

appDb.createUser({ user: appUser, pwd: appPassword, roles: ['aba1on1_app_role'] });

print(`Created role aba1on1_app_role and user ${appUser}. Point MONGODB_URI at this user in production.`);
