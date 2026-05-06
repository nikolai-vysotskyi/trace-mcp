import { IsString, Length } from 'class-validator';

export class AddressDto {
  @IsString()
  @Length(1, 100)
  street: string;

  @IsString()
  city: string;
}
