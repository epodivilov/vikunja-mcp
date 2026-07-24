/**
 * How every tool that names people spells that argument, so assign, unassign and create cannot
 * drift into three shapes of the same list.
 *
 * A username or a global id, mirroring the `labels` argument of `vikunja_create_task`: the name is
 * what a human reads, and the id exists only for the case where a name identifies two accounts.
 * At least one entry, refused here on the caller's own input rather than after a resolution that
 * would have nothing to do.
 */
import { z } from "zod";

export const usersField = z
  .array(z.union([z.string().trim().min(1), z.number().int().positive()]))
  .min(1);
