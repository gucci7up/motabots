import { Injectable, Logger } from '@nestjs/common';
import { Invoice, InvoiceStatus, Prisma } from '@prisma/client';
import { AuditAction, AuditService } from '../audit/audit.service';
import { PaginatedResult, paginate } from '../common/dto/pagination.dto';
import { DomainErrorCode, DomainException } from '../common/exceptions/domain.exception';
import { PrismaService } from '../database/prisma.service';
import { StorageService } from '../storage/storage.service';
import { InvoiceForPdf, InvoicePdfService } from './invoice-pdf.service';

const INVOICE_DETAIL = {
  customer: true,
  sale: { include: { items: true, creditAccount: true } },
} satisfies Prisma.InvoiceInclude;

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: InvoicePdfService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  async findById(id: string): Promise<InvoiceForPdf> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: INVOICE_DETAIL,
    });
    if (!invoice) {
      throw DomainException.notFound('la factura', id);
    }
    return invoice;
  }

  async findByNumber(number: string): Promise<InvoiceForPdf> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { number },
      include: INVOICE_DETAIL,
    });
    if (!invoice) {
      throw DomainException.notFound('la factura', number);
    }
    return invoice;
  }

  async findBySale(saleId: string): Promise<InvoiceForPdf> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { saleId },
      include: INVOICE_DETAIL,
    });
    if (!invoice) {
      throw DomainException.notFound('la factura de la venta', saleId);
    }
    return invoice;
  }

  async findAll(page: number, pageSize: number): Promise<PaginatedResult<Invoice>> {
    const [invoices, total] = await Promise.all([
      this.prisma.invoice.findMany({
        orderBy: { issueDate: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.invoice.count(),
    ]);

    return paginate(invoices, total, page, pageSize);
  }

  /**
   * Devuelve el PDF de la factura, generándolo si hace falta.
   *
   * Se regenera siempre que el archivo no exista en el almacenamiento; los importes ya
   * cobrados pueden haber cambiado tras un abono, así que `force` permite rehacerlo.
   */
  async getPdf(invoiceId: string, force = false): Promise<{ buffer: Buffer; filename: string }> {
    const invoice = await this.findById(invoiceId);
    const key = invoice.pdfStorageKey ?? this.pdf.storageKeyFor(invoice);
    const filename = `${invoice.number}.pdf`;

    if (!force && invoice.pdfStorageKey && (await this.storage.exists(invoice.pdfStorageKey))) {
      return { buffer: await this.storage.read(invoice.pdfStorageKey), filename };
    }

    const buffer = await this.pdf.generate(invoice);
    const stored = await this.storage.save(key, buffer, 'application/pdf');

    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        pdfStorageKey: stored.storageKey,
        pdfChecksum: stored.checksum,
        pdfSizeBytes: stored.sizeBytes,
      },
    });

    return { buffer, filename };
  }

  /**
   * Anula la factura. No se borra: se marca y queda el motivo.
   * Sólo aplica a facturas cuya venta sigue viva; cancelar la venta ya anula su factura.
   */
  async cancel(invoiceId: string, reason: string, userId: string): Promise<Invoice> {
    const invoice = await this.findById(invoiceId);

    if (invoice.status === InvoiceStatus.CANCELLED) {
      throw new DomainException(
        DomainErrorCode.INVOICE_ALREADY_CANCELLED,
        'Esta factura ya estaba anulada.',
      );
    }

    const cancelled = await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        status: InvoiceStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelledById: userId,
        cancellationReason: reason,
      },
    });

    await this.audit.record({
      userId,
      action: AuditAction.INVOICE_CANCELLED,
      entity: 'Invoice',
      entityId: invoiceId,
      before: { status: invoice.status },
      after: { status: InvoiceStatus.CANCELLED, reason },
    });

    this.logger.warn({ invoiceId, number: invoice.number }, 'Factura anulada');

    return cancelled;
  }
}
