import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { SYSTEM_ROLES } from '../../roles/permissions';

export class CreateUserDto {
  @ApiProperty({
    description: 'ID numérico de Telegram del usuario',
    example: '7045646241',
  })
  @IsString()
  @Matches(/^\d+$/, { message: 'telegramUserId debe ser un número' })
  telegramUserId: string;

  @ApiProperty({ enum: Object.values(SYSTEM_ROLES), example: 'SELLER' })
  @IsString()
  @IsIn(Object.values(SYSTEM_ROLES))
  roleName: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  username?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  firstName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  lastName?: string;
}
