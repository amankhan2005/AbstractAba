import { z } from 'zod';
import {
  GOAL_TERM,
  GOAL_STATUS,
  TARGET_MEASUREMENT_TYPE,
  TARGET_STATUS,
} from '../../models/enums.js';

const uuidSchema = z.string().uuid();
const dateSchema = z.string().trim().refine((v) => !Number.isNaN(Date.parse(v)), 'Enter a valid date');
const text = (max) => z.string().trim().min(1).max(max);
const optText = (max) => z.string().trim().max(max).optional();

// --- treatment plan --------------------------------------------------------

export const createPlanSchema = z
  .object({
    clientId: uuidSchema,
    title: text(200),
    // Optional (spec Module 7.1): creation does NOT ask for the responsible BCBA
    // — the authenticated BCBA is the creator and the server derives it. It may
    // still be supplied by an admin creating on a BCBA's behalf.
    responsibleBcbaStaffId: uuidSchema.optional(),
    // Allow creating a plan directly as ACTIVE, or leave it DRAFT (default).
    status: z.enum(['DRAFT', 'ACTIVE']).optional(),
    effectiveDate: dateSchema.optional(),
    reviewDate: dateSchema.optional(),
    notes: optText(4000),
  })
  .strict();

export const updatePlanSchema = z
  .object({
    title: text(200).optional(),
    responsibleBcbaStaffId: uuidSchema.optional(),
    status: z.enum(['DRAFT', 'ACTIVE']).optional(), // ARCHIVED is via the archive endpoint
    effectiveDate: dateSchema.optional(),
    reviewDate: dateSchema.optional(),
    notes: optText(4000),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

export const listPlansQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().trim().min(1).optional(),
  clientId: uuidSchema.optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
});

export const planIdParamsSchema = z.object({ planId: uuidSchema });

// --- goal ------------------------------------------------------------------

export const createGoalSchema = z
  .object({
    description: text(2000),
    term: z.enum(GOAL_TERM).optional(),
    priority: z.coerce.number().int().min(1).max(5).optional(),
    status: z.enum(GOAL_STATUS).optional(),
    progress: z.coerce.number().int().min(0).max(100).optional(),
  })
  .strict();

export const updateGoalSchema = createGoalSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'Provide at least one field to update' },
);

export const goalParamsSchema = z.object({ planId: uuidSchema, goalId: uuidSchema });

// --- program ---------------------------------------------------------------

export const createProgramSchema = z
  .object({
    name: text(200),
    instructions: optText(4000),
    teachingProcedure: optText(4000),
    reinforcementStrategy: optText(4000),
    promptHierarchy: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
    measurementMethod: optText(500),
  })
  .strict();

export const updateProgramSchema = createProgramSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'Provide at least one field to update' },
);

export const programParamsSchema = z.object({ planId: uuidSchema, goalId: uuidSchema, programId: uuidSchema });

// --- target ----------------------------------------------------------------

export const createTargetSchema = z
  .object({
    label: text(200),
    measurementType: z.enum(TARGET_MEASUREMENT_TYPE).optional(),
    baseline: optText(1000),
    masteryCriteria: optText(1000),
    currentProgress: z.coerce.number().int().min(0).max(100).optional(),
    status: z.enum(TARGET_STATUS).optional(),
    weeklyFocus: z.boolean().optional(),
    weeklyInstructions: optText(2000),
  })
  .strict();

export const updateTargetSchema = createTargetSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'Provide at least one field to update' },
);

export const targetParamsSchema = z.object({ planId: uuidSchema, programId: uuidSchema, targetId: uuidSchema });
export const programTargetParamsSchema = z.object({ planId: uuidSchema, programId: uuidSchema });
