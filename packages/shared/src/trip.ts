import { z } from 'zod';

export const TripSchema = z.object({
  id: z.string(),
  destination: z.string().min(1),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
});

export type Trip = z.infer<typeof TripSchema>;

export const TripListSchema = z.array(TripSchema);
