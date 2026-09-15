import { InsuranceCatalogService } from './insuranceCatalog.service.js';
import { insuranceCatalogRepository } from './insuranceCatalog.repository.js';
import { createInsuranceCatalogRouters } from './insuranceCatalog.routes.js';
import { Organization } from '../../models/index.js';
import { auditService } from '../audit/audit.service.js';
import { uploadLogo } from '../theming/logo-upload.service.js';

/**
 * Company lookup for state filtering. The catalog is platform-global, but the
 * tenant read filters by the company's own service states, so the service needs
 * to resolve the org. Returns just what the filter needs.
 */
const organizationsPort = {
  async getById(tenantId) {
    const org = await Organization.findOne({ _id: tenantId }).lean();
    if (!org) return null;
    return { id: org._id, serviceStates: org.serviceStates ?? [], stateCode: org.stateCode ?? null };
  },
};

export const insuranceCatalogService = new InsuranceCatalogService({
  repository: insuranceCatalogRepository,
  organizations: organizationsPort,
  // Super Admin catalog writes are audited on the platform chain (spec §19).
  audit: auditService,
  // Logo bytes go through the SAME Cloudinary uploader the company logo uses
  // (spec Module 6), foldered per catalog entry via an explicit public id.
  logoUploader: ({ publicId, buffer }) => uploadLogo({ publicId, buffer }),
});

export const insuranceCatalogRouters = createInsuranceCatalogRouters(insuranceCatalogService);
