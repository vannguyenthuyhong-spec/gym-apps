import type { Role } from '@prisma/client';

export interface AuthUser {
  id: string;
  orgId: string;
  role: Role;
}

export interface JwtPayload {
  sub: string;
  org: string;
  role: Role;
}
