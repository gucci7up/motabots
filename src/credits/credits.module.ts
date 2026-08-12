import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { CreditsService } from './credits.service';

@Module({
  imports: [CustomersModule],
  providers: [CreditsService],
  exports: [CreditsService],
})
export class CreditsModule {}
