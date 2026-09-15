/**
 * Shared audit/attribution columns (Module 1 §7.1): created/updated attribution
 * and an optimistic-concurrency version counter. Applied to models that carried
 * these in the Prisma schema. Timestamps come from Mongoose's own `timestamps`
 * option per model; this plugin adds the attribution + version columns and the
 * optimistic bump on save.
 */
export function attributionFields(schema, { softDelete = false } = {}) {
  schema.add({
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
    version: { type: Number, default: 1 },
    ...(softDelete
      ? { deletedAt: { type: Date, default: null }, deletedBy: { type: String, default: null } }
      : {}),
  });

  schema.pre('save', function bumpVersion(next) {
    if (!this.isNew && this.isModified()) this.version += 1;
    next();
  });
}
