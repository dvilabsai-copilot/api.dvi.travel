import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { SystemRole } from '../../auth/constants/system-role.constants';

@Injectable()
export class HotelAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request?.user;

    const roleId = Number(
      user?.roleID ??
      user?.roleId ??
      user?.role ??
      0,
    );

    if (roleId !== SystemRole.HOTEL_ADMIN) {
      throw new ForbiddenException('Hotel Admin access required');
    }

    return true;
  }
}