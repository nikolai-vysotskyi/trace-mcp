import { IsEmail, IsOptional, IsString, Length, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { AddressDto } from './address.dto';

export class CreateUserDto {
  @IsString()
  @Length(2, 50)
  name: string;

  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  nickname?: string;

  @ValidateNested()
  @Type(() => AddressDto)
  address: AddressDto;
}
