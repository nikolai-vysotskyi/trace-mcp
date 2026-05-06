import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CreateUserDto } from './create-user.dto';

@Controller('users')
@UseGuards(AuthGuard('jwt'))
export class UsersController {
  @Post()
  create(@Body() dto: CreateUserDto) {
    return { id: '1', ...dto };
  }
}
