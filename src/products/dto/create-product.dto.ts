import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MeasurementUnit } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsNumberString,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CreateVariantDto {
  @ApiProperty({ example: '30ml', description: 'Nombre de la variante' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({ example: '30', description: 'Valor del tamaño, sin unidad' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  size?: string;

  @ApiPropertyOptional({ enum: MeasurementUnit, default: MeasurementUnit.UNIT })
  @IsOptional()
  @IsEnum(MeasurementUnit)
  unit?: MeasurementUnit;

  @ApiProperty({ example: '800.00', description: 'Precio de venta. Se envía como texto para no perder precisión.' })
  @IsNumberString({ no_symbols: false })
  salePrice: string;

  @ApiProperty({ example: '245.20', description: 'Costo unitario' })
  @IsNumberString({ no_symbols: false })
  costPrice: string;

  @ApiPropertyOptional({ example: '2', description: 'Stock mínimo para alertas' })
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
}

export class CreateProductDto {
  @ApiProperty({ example: 'Black Opium Yves Saint Laurent' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  brand?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sku?: string;

  @ApiProperty({ type: [CreateVariantDto], description: 'Al menos una variante' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateVariantDto)
  variants: CreateVariantDto[];
}
