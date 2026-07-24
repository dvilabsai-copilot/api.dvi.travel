// FILE: src/modules/users/users.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { Role } from 'src/auth/roles.decorator';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

 // TODO: Wire to a real User model once you add it to prisma.schema
  async findAll() {
    return [];
  }

  async findOne(id: number) {
    return null;
  }

  async updateRole(id: number, role: Role) {
 // Implement once you have a User model
    return null;
  }
}
