import { z } from "zod";

export const requestCodeSchema = z.object({
  email: z.string().email(),
  displayName: z.string().trim().min(1).max(80).optional(),
});

export const verifyCodeSchema = z.object({
  email: z.string().email(),
  code: z.string().trim().min(6).max(12),
});

export const createHouseholdSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export const inviteSchema = z.object({
  email: z.string().email(),
});

export const acceptInviteSchema = z.object({
  code: z.string().trim().min(8).max(24),
});

export const addItemSchema = z.object({
  name: z.string().trim().min(1).max(120),
  note: z.string().trim().max(280).optional().or(z.literal("")),
});

export const updateItemSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  note: z.string().trim().max(280).nullable().optional(),
  categoryKey: z.string().trim().min(1).max(40).optional(),
  status: z.enum(["active", "completed"]).optional(),
});
