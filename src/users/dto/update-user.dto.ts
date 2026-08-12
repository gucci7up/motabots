import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { SYSTEM_ROLES } from '../../roles/permissions';

export class UpdateUserDto {
  @ApiPropertyOptional({ enum: Object.values(SYSTEM_ROLES) })
  @IsOptional()
  @IsString()
  @IsIn(Object.values(SYSTEM_ROLES))
  roleName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

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
