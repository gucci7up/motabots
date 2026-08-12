import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNumberString, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateVariantDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ description: 'Nuevo precio de venta' })
  @IsOptional()
  @IsNumberString({ no_symbols: false })
  salePrice?: string;

  @ApiPropertyOptional({ description: 'Nuevo costo unitario. No altera ventas ya registradas.' })
  @IsOptional()
  @IsNumberString({ no_symbols: false })
  costPrice?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString({ no_symbols: false })
  minimumStock?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sku?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  barcode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
