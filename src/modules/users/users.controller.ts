// FILE: src/modules/users/users.controller.ts

import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { Roles } from '../../auth/roles.decorator';
import { SwaggerRole } from '../../auth/swagger-role.enum';

@ApiTags('users')
@ApiBearerAuth() // uses default bearer auth from main.ts
@Controller('users')
export class UsersController {
  constructor(private users: UsersService) {}

  @ApiOperation({ summary: 'List users' })
  @Roles(SwaggerRole.admin as any)
  @Get()
  findAll() {
    return this.users.findAll();
  }



}
