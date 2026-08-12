import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsNumberString,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class SaleItemDto {
  @ApiProperty()
  @IsString()
  productVariantId: string;

  @ApiProperty({ example: '2' })
  @IsNumberString({ no_symbols: false })
  quantity: string;

  @ApiPropertyOptional({
    description: 'Precio unitario. Si se omite, se usa el precio vigente de la variante.',
  })
  @IsOptional()
  @IsNumberString({ no_symbols: false })
  unitPrice?: string;

  @ApiPropertyOptional({ description: 'Descuento aplicado a la línea completa' })
  @IsOptional()
  @IsNumberString({ no_symbols: false })
  discount?: string;
}

export class SalePaymentDto {
  @ApiProperty({ example: '1000.00' })
  @IsNumberString({ no_symbols: false })
  amount: string;

  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;
}

export class CreateSaleDto {
  @ApiPropertyOptional({ description: 'Sin cliente, la venta es al contado y anónima' })
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiProperty({ type: [SaleItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SaleItemDto)
  items: SaleItemDto[];

  @ApiPropertyOptional({ description: 'Descuento global sobre el subtotal' })
  @IsOptional()
  @IsNumberString({ no_symbols: false })
  discount?: string;

  @ApiPropertyOptional({ type: [SalePaymentDto], description: 'Pagos recibidos al vender' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SalePaymentDto)
  payments?: SalePaymentDto[];

  @ApiPropertyOptional({
    description: 'Vencimiento del crédito. Obligatorio si queda saldo pendiente.',
    example: '2026-08-27',
  })
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @ApiPropertyOptional({
    description: 'Clave de idempotencia: evita duplicar la venta si se confirma dos veces',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  idempotencyKey?: string;
}
