import { z } from 'zod';

/**
 * Dashboards take no request bodies (they are read-only). The only accepted
 * input is an optional `staffProfileId` on the role dashboards that are scoped
 * to one clinician (BCBA / RBT), so a supervisor can view a specific staff
 * member's board; omitted, the endpoint returns the org-wide view for that role.
 */
export const dashboardQuerySchema = z.object({
  staffProfileId: z.string().uuid().optional(),
});
