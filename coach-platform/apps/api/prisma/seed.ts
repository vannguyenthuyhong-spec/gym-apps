/* Dev-only seed: one org, one coach, one trainee, a small exercise library. */
import argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed in production');

  const coachEmail = process.env.SEED_COACH_EMAIL ?? 'coach@example.test';
  const traineeEmail = process.env.SEED_TRAINEE_EMAIL ?? 'trainee@example.test';
  const password = process.env.SEED_PASSWORD ?? 'ChangeMe123!';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  const existing = await prisma.user.findUnique({ where: { email: coachEmail } });
  if (existing) {
    console.log('Seed data already present — skipping');
    return;
  }

  const org = await prisma.organization.create({ data: { name: 'Demo Gym' } });
  const coach = await prisma.user.create({
    data: { orgId: org.id, email: coachEmail, passwordHash, fullName: 'HLV Demo', role: 'COACH' },
  });
  await prisma.user.create({
    data: {
      orgId: org.id,
      email: traineeEmail,
      passwordHash,
      fullName: 'Học viên Demo',
      role: 'TRAINEE',
      traineeProfile: {
        create: { orgId: org.id, coachId: coach.id, goal: 'Giảm 5kg, squat 100kg', startDate: new Date() },
      },
    },
  });

  const exercises: [string, string, string[]][] = [
    ['Back Squat', 'Sức mạnh', ['reps', 'weight_kg', 'rpe']],
    ['Bench Press', 'Sức mạnh', ['reps', 'weight_kg', 'rpe']],
    ['Deadlift', 'Sức mạnh', ['reps', 'weight_kg', 'rpe']],
    ['Plank', 'Core', ['duration_sec']],
    ['Chạy bộ', 'Cardio', ['distance_m', 'duration_sec']],
  ];
  await prisma.exercise.createMany({
    data: exercises.map(([name, category, trackingFields]) => ({
      orgId: org.id,
      createdById: coach.id,
      name,
      category,
      trackingFields,
    })),
  });

  console.log(`Seeded org "${org.name}" with ${coachEmail} / ${traineeEmail} (password from SEED_PASSWORD or default)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
