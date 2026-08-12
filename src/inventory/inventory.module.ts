import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module';
import { InventoryService } from './inventory.service';

@Module({
  imports: [ProductsModule],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
