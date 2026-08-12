import { Injectable } from '@nestjs/common';
import { InvoiceStatus, Prisma } from '@prisma/client';
import PDFDocument from 'pdfkit';
import { formatMoney, formatQuantity, money } from '../common/money';
import { SettingKey, SettingsService } from '../settings/settings.service';

export type InvoiceForPdf = Prisma.InvoiceGetPayload<{
  include: { customer: true; sale: { include: { items: true; creditAccount: true } } };
}>;

interface StoreInfo {
  name: string;
  phone: string;
  address: string;
  currencySymbol: string;
}

const MARGIN = 45;
const PAGE_WIDTH = 595.28; // A4 en puntos
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

/** Columnas de la tabla de productos, en puntos desde el margen izquierdo. */
const COL = {
  description: MARGIN,
  quantity: MARGIN + 250,
  unitPrice: MARGIN + 310,
  total: MARGIN + 400,
};

@Injectable()
export class InvoicePdfService {
  constructor(private readonly settings: SettingsService) {}

  /** Genera el PDF de la factura en memoria. El almacenamiento es responsabilidad del llamador. */
  async generate(invoice: InvoiceForPdf): Promise<Buffer> {
    const store = await this.loadStoreInfo();

    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: MARGIN });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      try {
        this.renderHeader(doc, store, invoice);
        this.renderCustomer(doc, invoice);
        const tableBottom = this.renderItems(doc, invoice, store);
        this.renderTotals(doc, invoice, store, tableBottom);
        this.renderFooter(doc, store, invoice);
        doc.end();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Nombre del archivo dentro del almacenamiento. */
  storageKeyFor(invoice: { number: string; issueDate: Date }): string {
    const year = invoice.issueDate.getFullYear();
    const month = String(invoice.issueDate.getMonth() + 1).padStart(2, '0');
    const safeNumber = invoice.number.replace(/[^\w-]/g, '_');
    return `invoices/${year}/${month}/${safeNumber}.pdf`;
  }

  private async loadStoreInfo(): Promise<StoreInfo> {
    const [name, phone, address, currencySymbol] = await Promise.all([
      this.settings.getString(SettingKey.STORE_NAME, 'MotaParfum'),
      this.settings.getString(SettingKey.STORE_PHONE, ''),
      this.settings.getString(SettingKey.STORE_ADDRESS, ''),
      this.settings.getString(SettingKey.CURRENCY_SYMBOL, 'RD$'),
    ]);

    return { name, phone, address, currencySymbol };
  }

  private renderHeader(
    doc: PDFKit.PDFDocument,
    store: StoreInfo,
    invoice: InvoiceForPdf,
  ): void {
    doc.font('Helvetica-Bold').fontSize(22).text(store.name.toUpperCase(), MARGIN, MARGIN);

    doc.font('Helvetica').fontSize(9);
    let y = doc.y + 2;
    if (store.address) {
      doc.text(store.address, MARGIN, y, { width: 300 });
      y = doc.y;
    }
    if (store.phone) {
      doc.text(`Tel. ${store.phone}`, MARGIN, y, { width: 300 });
    }

    // Bloque de factura, alineado a la derecha
    doc.font('Helvetica-Bold').fontSize(14).text('FACTURA', MARGIN, MARGIN, {
      width: CONTENT_WIDTH,
      align: 'right',
    });
    doc.font('Helvetica').fontSize(10);
    doc.text(invoice.number, MARGIN, MARGIN + 20, { width: CONTENT_WIDTH, align: 'right' });
    doc.text(this.formatDate(invoice.issueDate), MARGIN, MARGIN + 34, {
      width: CONTENT_WIDTH,
      align: 'right',
    });

    if (invoice.status === InvoiceStatus.CANCELLED) {
      doc
        .font('Helvetica-Bold')
        .fontSize(12)
        .fillColor('#b00020')
        .text('ANULADA', MARGIN, MARGIN + 50, { width: CONTENT_WIDTH, align: 'right' })
        .fillColor('black');
    }

    doc.moveTo(MARGIN, MARGIN + 78).lineTo(PAGE_WIDTH - MARGIN, MARGIN + 78).stroke();
  }

  private renderCustomer(doc: PDFKit.PDFDocument, invoice: InvoiceForPdf): void {
    const top = MARGIN + 92;

    doc.font('Helvetica-Bold').fontSize(10).text('CLIENTE', MARGIN, top);
    doc.font('Helvetica').fontSize(10);

    const customer = invoice.customer;
    if (!customer) {
      doc.text('Consumidor final', MARGIN, top + 15);
      return;
    }

    let y = top + 15;
    doc.text(customer.name, MARGIN, y);
    y = doc.y;
    if (customer.phone) {
      doc.text(`Tel. ${customer.phone}`, MARGIN, y);
      y = doc.y;
    }
    if (customer.identificationNumber) {
      doc.text(`ID ${customer.identificationNumber}`, MARGIN, y);
      y = doc.y;
    }
    if (customer.address) {
      doc.text(customer.address, MARGIN, y, { width: 300 });
    }
  }

  private renderItems(
    doc: PDFKit.PDFDocument,
    invoice: InvoiceForPdf,
    store: StoreInfo,
  ): number {
    let y = Math.max(doc.y + 25, MARGIN + 165);

    doc.font('Helvetica-Bold').fontSize(9);
    doc.text('DESCRIPCIÓN', COL.description, y);
    doc.text('CANT.', COL.quantity, y, { width: 50, align: 'right' });
    doc.text('PRECIO', COL.unitPrice, y, { width: 80, align: 'right' });
    doc.text('TOTAL', COL.total, y, { width: PAGE_WIDTH - MARGIN - COL.total, align: 'right' });

    y += 14;
    doc.moveTo(MARGIN, y).lineTo(PAGE_WIDTH - MARGIN, y).stroke();
    y += 8;

    doc.font('Helvetica').fontSize(9);

    for (const item of invoice.sale.items) {
      // Salto de página si la línea no cabe: una factura larga no debe recortarse.
      if (y > 690) {
        doc.addPage();
        y = MARGIN;
      }

      const description = doc.heightOfString(item.descriptionSnapshot, { width: 240 });

      doc.text(item.descriptionSnapshot, COL.description, y, { width: 240 });
      doc.text(formatQuantity(item.quantity), COL.quantity, y, { width: 50, align: 'right' });
      doc.text(formatMoney(item.unitPrice, store.currencySymbol), COL.unitPrice, y, {
        width: 80,
        align: 'right',
      });
      doc.text(formatMoney(item.total, store.currencySymbol), COL.total, y, {
        width: PAGE_WIDTH - MARGIN - COL.total,
        align: 'right',
      });

      y += Math.max(description, 12) + 6;

      if (money(item.discount).greaterThan(0)) {
        doc
          .fontSize(8)
          .fillColor('#555555')
          .text(
            `Descuento: ${formatMoney(item.discount, store.currencySymbol)}`,
            COL.description + 10,
            y - 3,
          )
          .fillColor('black')
          .fontSize(9);
        y += 12;
      }
    }

    doc.moveTo(MARGIN, y).lineTo(PAGE_WIDTH - MARGIN, y).stroke();
    return y + 10;
  }

  private renderTotals(
    doc: PDFKit.PDFDocument,
    invoice: InvoiceForPdf,
    store: StoreInfo,
    top: number,
  ): void {
    const labelX = MARGIN + 300;
    const valueX = COL.total;
    const valueWidth = PAGE_WIDTH - MARGIN - COL.total;
    let y = top;

    const line = (label: string, value: Prisma.Decimal, bold = false): void => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9);
      doc.text(label, labelX, y, { width: 90, align: 'right' });
      doc.text(formatMoney(value, store.currencySymbol), valueX, y, {
        width: valueWidth,
        align: 'right',
      });
      y += bold ? 18 : 14;
    };

    line('Subtotal', invoice.subtotal);

    if (money(invoice.discount).greaterThan(0)) {
      line('Descuento', invoice.discount);
    }
    if (money(invoice.taxAmount).greaterThan(0)) {
      line('Impuesto', invoice.taxAmount);
    }

    line('TOTAL', invoice.total, true);
    line('Pagado', invoice.paidAmount);

    // El saldo pendiente es la información más importante de una venta a crédito:
    // se destaca para que el cliente no tenga que buscarla.
    if (money(invoice.pendingAmount).greaterThan(0)) {
      y += 4;
      doc
        .font('Helvetica-Bold')
        .fontSize(12)
        .fillColor('#b00020')
        .text('SALDO PENDIENTE', labelX - 40, y, { width: 130, align: 'right' })
        .text(formatMoney(invoice.pendingAmount, store.currencySymbol), valueX, y, {
          width: valueWidth,
          align: 'right',
        })
        .fillColor('black');
      y += 20;

      const credit = invoice.sale.creditAccount;
      if (credit) {
        doc
          .font('Helvetica')
          .fontSize(9)
          .text(`Vence el ${this.formatDate(credit.dueDate)}`, labelX - 40, y, {
            width: 130 + valueWidth,
            align: 'right',
          });
      }
    }
  }

  private renderFooter(
    doc: PDFKit.PDFDocument,
    store: StoreInfo,
    invoice: InvoiceForPdf,
  ): void {
    const y = 760;
    doc.moveTo(MARGIN, y).lineTo(PAGE_WIDTH - MARGIN, y).stroke();
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#555555')
      .text(`¡Gracias por su compra! · ${store.name}`, MARGIN, y + 8, {
        width: CONTENT_WIDTH,
        align: 'center',
      })
      .text(`Documento ${invoice.number}`, MARGIN, y + 20, {
        width: CONTENT_WIDTH,
        align: 'center',
      })
      .fillColor('black');
  }

  private formatDate(date: Date): string {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${day}/${month}/${date.getFullYear()}`;
  }
}
