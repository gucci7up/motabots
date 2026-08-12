import { Module } from '@nestjs/common';
import { CategoriesModule } from '../categories/categories.module';
import { ProductsService } from './products.service';

@Module({
  imports: [CategoriesModule],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
