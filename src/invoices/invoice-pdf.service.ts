import { Injectable, Logger } from '@nestjs/common';
import { InvoiceStatus, Prisma } from '@prisma/client';
import PDFDocument from 'pdfkit';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatLocalDate } from '../common/date-range';
import { formatMoney, formatQuantity, money } from '../common/money';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { StorageService } from '../storage/storage.service';

export type InvoiceForPdf = Prisma.InvoiceGetPayload<{
  include: { customer: true; sale: { include: { items: true; creditAccount: true } } };
}>;

interface StoreInfo {
  name: string;
  phone: string;
  address: string;
  currencySymbol: string;
  social: Record<string, string>;
  logo?: Buffer;
}

/** Paleta de MotaParfum: negro y rojo, tomados del logo. */
const COLOR = {
  black: '#111111',
  red: '#D81324',
  redDark: '#A50E1B',
  ink: '#2A2F3A',
  muted: '#7A8190',
  zebra: '#F0F0F0',
  hairline: '#D8DBE0',
  danger: '#C0392B',
  dangerBg: '#FDEDEA',
  white: '#FFFFFF',
};

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 48;
const CONTENT = PAGE.width - MARGIN * 2;

/** Columnas de la tabla, medidas desde el borde izquierdo. */
const COL = {
  description: MARGIN + 14,
  unitPrice: MARGIN + 250,
  quantity: MARGIN + 350,
  total: MARGIN + 405,
};
const COL_WIDTH = {
  description: 225,
  unitPrice: 90,
  quantity: 50,
  total: CONTENT - 14 - (COL.total - MARGIN),
};

const FOOTER_BAND_HEIGHT = 46;
const FOOTER_TOP = PAGE.height - FOOTER_BAND_HEIGHT;
/** Límite inferior del área de contenido antes de invadir el pie. */
const CONTENT_BOTTOM = FOOTER_TOP - 24;

@Injectable()
export class InvoicePdfService {
  private readonly logger = new Logger(InvoicePdfService.name);

  constructor(
    private readonly settings: SettingsService,
    private readonly storage: StorageService,
  ) {}

  /** Genera el PDF en memoria. Guardarlo es responsabilidad del llamador. */
  async generate(invoice: InvoiceForPdf): Promise<Buffer> {
    const store = await this.loadStoreInfo();

    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      try {
        this.renderHeader(doc, store);
        const metaBottom = this.renderMeta(doc, invoice);
        const tableBottom = this.renderItems(doc, invoice, store, metaBottom);
        const totalsBottom = this.renderTotals(doc, invoice, store, tableBottom);
        this.renderPaymentInfo(doc, invoice, store, tableBottom);
        this.renderTerms(doc, invoice, totalsBottom);

        if (invoice.status === InvoiceStatus.CANCELLED) {
          this.renderCancelledStamp(doc);
        }

        this.renderFooters(doc, store, invoice);
        doc.end();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  storageKeyFor(invoice: { number: string; issueDate: Date }): string {
    const year = invoice.issueDate.getFullYear();
    const month = String(invoice.issueDate.getMonth() + 1).padStart(2, '0');
    const safeNumber = invoice.number.replace(/[^\w-]/g, '_');
    return `invoices/${year}/${month}/${safeNumber}.pdf`;
  }

  private async loadStoreInfo(): Promise<StoreInfo> {
    const [name, phone, address, currencySymbol, social, logoKey] = await Promise.all([
      this.settings.getString(SettingKey.STORE_NAME, 'MotaParfum'),
      this.settings.getString(SettingKey.STORE_PHONE, ''),
      this.settings.getString(SettingKey.STORE_ADDRESS, ''),
      this.settings.getString(SettingKey.CURRENCY_SYMBOL, 'RD$'),
      this.settings.get<Record<string, string>>('store.socialMedia' as never, {}),
      this.settings.getString(SettingKey.STORE_LOGO, ''),
    ]);

    return {
      name,
      phone,
      address,
      currencySymbol,
      social: social ?? {},
      logo: await this.loadLogo(logoKey),
    };
  }

  /**
   * Busca el logo primero en el almacenamiento (donde lo deja la configuración) y, si no
   * está, en el que viene con la imagen. El volumen de producción arranca vacío, así que
   * sin este respaldo la primera factura saldría sin logo.
   */
  private async loadLogo(logoKey: string): Promise<Buffer | undefined> {
    if (logoKey) {
      try {
        return await this.storage.read(logoKey);
      } catch {
        this.logger.warn({ logoKey }, 'Logo no encontrado en el almacenamiento; uso el incluido');
      }
    }

    try {
      return await readFile(join(process.cwd(), 'assets', 'logo.png'));
    } catch {
      // Sin logo la factura sigue siendo válida: no se interrumpe la emisión por esto.
      return undefined;
    }
  }

  // ── Cabecera con formas diagonales ─────────────────────────

  private renderHeader(doc: PDFKit.PDFDocument, store: StoreInfo): void {
    // Franja roja superior con el extremo derecho en diagonal.
    doc.polygon([0, 24], [356, 24], [316, 84], [0, 84]).fill(COLOR.red);

    // Bloque negro con el borde izquierdo inclinado, encima de la franja.
    doc
      .polygon([326, 0], [PAGE.width, 0], [PAGE.width, 100], [272, 100])
      .fill(COLOR.black);

    // Acento rojo bajo el bloque negro, a la derecha.
    doc
      .polygon([PAGE.width - 74, 100], [PAGE.width, 100], [PAGE.width, 152])
      .fill(COLOR.red);

    doc
      .fillColor(COLOR.white)
      .font('Helvetica-Bold')
      .fontSize(30)
      .text('FACTURA', PAGE.width - MARGIN - 230, 30, {
        width: 230,
        align: 'right',
        characterSpacing: 1,
      });

    // La identidad va sobre fondo blanco, debajo de la franja: el logo tiene detalle
    // y sobre el rojo se perdería.
    const identityTop = 100;
    let textLeft = MARGIN;

    if (store.logo) {
      try {
        doc.image(store.logo, MARGIN, identityTop - 6, { fit: [74, 74] });
        textLeft = MARGIN + 84;
      } catch (error) {
        this.logger.warn({ err: error }, 'El logo no es una imagen válida; se omite');
      }
    }

    doc
      .fillColor(COLOR.black)
      .font('Helvetica-Bold')
      .fontSize(20)
      .text(store.name.toUpperCase(), textLeft, identityTop + 12, { width: 240 });

    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor(COLOR.red)
      .text('FINE FRAGRANCES', textLeft, identityTop + 36, {
        width: 240,
        characterSpacing: 2,
      });

    doc.fillColor(COLOR.ink);
  }

  // ── Datos de la factura y del cliente ──────────────────────

  private renderMeta(doc: PDFKit.PDFDocument, invoice: InvoiceForPdf): number {
    const top = 200;

    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR.ink);
    doc.text('FACTURA NO', MARGIN, top, { continued: true });
    doc.font('Helvetica').fillColor(COLOR.muted).text(` :  ${invoice.number}`);

    doc.font('Helvetica-Bold').fillColor(COLOR.ink);
    doc.text('FECHA', MARGIN, top + 16, { continued: true });
    doc
      .font('Helvetica')
      .fillColor(COLOR.muted)
      .text(` :  ${formatLocalDate(invoice.issueDate)}`);

    // Bloque del cliente, alineado a la derecha.
    const rightX = PAGE.width - MARGIN - 250;

    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(COLOR.ink)
      .text('FACTURAR A', rightX, top, { width: 250, align: 'right' });

    const customer = invoice.customer;

    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(COLOR.red)
      .text((customer?.name ?? 'Consumidor final').toUpperCase(), rightX, top + 14, {
        width: 250,
        align: 'right',
      });

    doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.muted);
    let y = doc.y + 1;

    const details = [
      customer?.phone ? `Tel. ${customer.phone}` : null,
      customer?.identificationNumber ? `Cédula/RNC ${customer.identificationNumber}` : null,
      customer?.address ?? null,
    ].filter((value): value is string => Boolean(value));

    for (const line of details) {
      doc.text(line, rightX, y, { width: 250, align: 'right' });
      y = doc.y;
    }

    doc.fillColor(COLOR.ink);
    return Math.max(top + 62, y + 18);
  }

  // ── Tabla de productos ─────────────────────────────────────

  private renderItems(
    doc: PDFKit.PDFDocument,
    invoice: InvoiceForPdf,
    store: StoreInfo,
    top: number,
  ): number {
    let y = this.renderTableHeader(doc, top);
    let zebra = false;

    for (const item of invoice.sale.items) {
      doc.font('Helvetica').fontSize(9);

      const descriptionHeight = doc.heightOfString(item.descriptionSnapshot, {
        width: COL_WIDTH.description,
      });
      const hasDiscount = money(item.discount).greaterThan(0);
      const rowHeight = Math.max(descriptionHeight + 16, 30) + (hasDiscount ? 12 : 0);

      // Salto de página: una factura larga no debe recortarse ni pisar el pie.
      if (y + rowHeight > CONTENT_BOTTOM - 150) {
        doc.addPage();
        y = this.renderTableHeader(doc, MARGIN + 12);
        zebra = false;
      }

      if (zebra) {
        doc.rect(MARGIN, y, CONTENT, rowHeight).fill(COLOR.zebra);
      }
      zebra = !zebra;

      const textY = y + 9;

      doc.fillColor(COLOR.ink).font('Helvetica').fontSize(9);
      doc.text(item.descriptionSnapshot, COL.description, textY, {
        width: COL_WIDTH.description,
      });
      doc.text(formatMoney(item.unitPrice, store.currencySymbol), COL.unitPrice, textY, {
        width: COL_WIDTH.unitPrice,
        align: 'right',
      });
      doc.text(formatQuantity(item.quantity), COL.quantity, textY, {
        width: COL_WIDTH.quantity,
        align: 'right',
      });
      doc
        .font('Helvetica-Bold')
        .text(formatMoney(item.total, store.currencySymbol), COL.total, textY, {
          width: COL_WIDTH.total,
          align: 'right',
        });

      if (hasDiscount) {
        doc
          .font('Helvetica-Oblique')
          .fontSize(7.5)
          .fillColor(COLOR.red)
          .text(
            `Descuento ${formatMoney(item.discount, store.currencySymbol)}`,
            COL.description,
            textY + Math.max(descriptionHeight, 11) + 2,
            { width: COL_WIDTH.description },
          );
      }

      y += rowHeight;
    }

    doc.fillColor(COLOR.ink);
    return y + 26;
  }

  private renderTableHeader(doc: PDFKit.PDFDocument, y: number): number {
    doc.rect(MARGIN, y, CONTENT, 26).fill(COLOR.red);

    doc.fillColor(COLOR.white).font('Helvetica-Bold').fontSize(8.5);
    doc.text('PRODUCTO', COL.description, y + 9, { characterSpacing: 0.5 });
    doc.text('PRECIO', COL.unitPrice, y + 9, { width: COL_WIDTH.unitPrice, align: 'right' });
    doc.text('CANT.', COL.quantity, y + 9, { width: COL_WIDTH.quantity, align: 'right' });
    doc.text('TOTAL', COL.total, y + 9, { width: COL_WIDTH.total, align: 'right' });

    doc.fillColor(COLOR.ink);
    return y + 26;
  }

  // ── Totales ────────────────────────────────────────────────

  private renderTotals(
    doc: PDFKit.PDFDocument,
    invoice: InvoiceForPdf,
    store: StoreInfo,
    top: number,
  ): number {
    const labelX = PAGE.width - MARGIN - 230;
    const labelWidth = 120;
    const valueX = PAGE.width - MARGIN - 105;
    const valueWidth = 105;

    let y = top;

    const row = (label: string, value: Prisma.Decimal): void => {
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(COLOR.red)
        .text(label, labelX, y, { width: labelWidth, align: 'right' });

      doc
        .font('Helvetica-Bold')
        .fillColor(COLOR.ink)
        .text(formatMoney(value, store.currencySymbol), valueX, y, {
          width: valueWidth,
          align: 'right',
        });

      y += 16;
    };

    row('SUBTOTAL', invoice.subtotal);

    if (money(invoice.discount).greaterThan(0)) {
      row('DESCUENTO', invoice.discount);
    }
    if (money(invoice.taxAmount).greaterThan(0)) {
      row('ITBIS', invoice.taxAmount);
    }

    doc
      .moveTo(labelX, y + 2)
      .lineTo(PAGE.width - MARGIN, y + 2)
      .lineWidth(1)
      .stroke(COLOR.ink);

    y += 10;

    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(COLOR.red)
      .text('TOTAL', labelX, y, { width: labelWidth, align: 'right' });

    doc
      .fontSize(13)
      .fillColor(COLOR.ink)
      .text(formatMoney(invoice.total, store.currencySymbol), valueX, y - 2, {
        width: valueWidth,
        align: 'right',
      });

    y += 22;

    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(COLOR.muted)
      .text('Pagado', labelX, y, { width: labelWidth, align: 'right' });
    doc
      .font('Helvetica-Bold')
      .fillColor(COLOR.ink)
      .text(formatMoney(invoice.paidAmount, store.currencySymbol), valueX, y, {
        width: valueWidth,
        align: 'right',
      });

    y += 18;

    const pending = money(invoice.pendingAmount);

    // El saldo pendiente va en su propio recuadro: es el dato que el cliente debe ver.
    if (pending.greaterThan(0) && invoice.status !== InvoiceStatus.CANCELLED) {
      const credit = invoice.sale.creditAccount;
      const boxWidth = 230;
      const boxX = PAGE.width - MARGIN - boxWidth;
      const boxHeight = credit ? 48 : 34;

      doc.rect(boxX, y, boxWidth, boxHeight).fill(COLOR.dangerBg);
      doc.rect(boxX, y, 4, boxHeight).fill(COLOR.danger);

      doc
        .font('Helvetica-Bold')
        .fontSize(8)
        .fillColor(COLOR.danger)
        .text('SALDO PENDIENTE', boxX + 14, y + 9, { characterSpacing: 0.8 });

      doc
        .fontSize(14)
        .text(formatMoney(pending, store.currencySymbol), boxX + 14, y + 6, {
          width: boxWidth - 28,
          align: 'right',
        });

      if (credit) {
        doc
          .font('Helvetica')
          .fontSize(8.5)
          .fillColor(COLOR.danger)
          .text(`Fecha de pago: ${formatLocalDate(credit.dueDate)}`, boxX + 14, y + 30, {
            width: boxWidth - 28,
            align: 'right',
          });
      }

      y += boxHeight;
    }

    doc.fillColor(COLOR.ink);
    return y + 10;
  }

  // ── Información de pago (columna izquierda) ────────────────

  private renderPaymentInfo(
    doc: PDFKit.PDFDocument,
    invoice: InvoiceForPdf,
    store: StoreInfo,
    top: number,
  ): void {
    const width = 230;

    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLOR.red);
    doc.text('INFORMACIÓN', MARGIN, top, { continued: true });
    doc.fillColor(COLOR.ink).text(' DE PAGO');

    doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.muted);
    let y = top + 16;

    const statusLabel: Record<InvoiceStatus, string> = {
      ISSUED: 'Emitida',
      PAID: 'Pagada',
      PARTIAL: 'Pago parcial',
      CREDIT: 'A crédito',
      CANCELLED: 'Anulada',
    };

    const rows: [string, string][] = [
      ['Estado', statusLabel[invoice.status]],
      ['Total', formatMoney(invoice.total, store.currencySymbol)],
      ['Pagado', formatMoney(invoice.paidAmount, store.currencySymbol)],
    ];

    if (money(invoice.pendingAmount).greaterThan(0)) {
      rows.push(['Pendiente', formatMoney(invoice.pendingAmount, store.currencySymbol)]);
    }

    for (const [label, value] of rows) {
      doc.font('Helvetica').fillColor(COLOR.muted).text(label, MARGIN, y, {
        width: 70,
        continued: true,
      });
      doc.fillColor(COLOR.ink).text(`  :   ${value}`, { width: width - 70 });
      y = doc.y + 2;
    }

    doc.fillColor(COLOR.ink);
  }

  // ── Términos y firma ───────────────────────────────────────

  private renderTerms(doc: PDFKit.PDFDocument, invoice: InvoiceForPdf, top: number): void {
    const y = Math.min(Math.max(top + 18, 620), CONTENT_BOTTOM - 92);

    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLOR.ink);
    doc.text('TÉRMINOS Y ', MARGIN, y, { continued: true });
    doc.fillColor(COLOR.red).text('CONDICIONES');

    const terms =
      invoice.notes?.trim() ||
      'Los productos vendidos no tienen devolución una vez abiertos. ' +
        'Las ventas a crédito deben saldarse en la fecha acordada. ' +
        'Conserve esta factura como comprobante de su compra.';

    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(COLOR.muted)
      .text(terms, MARGIN, y + 16, { width: 250, lineGap: 1.5 });

    // Línea de firma
    const signX = PAGE.width - MARGIN - 170;
    doc
      .moveTo(signX, y + 52)
      .lineTo(PAGE.width - MARGIN, y + 52)
      .lineWidth(0.8)
      .stroke(COLOR.hairline);

    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(COLOR.muted)
      .text('Firma autorizada', signX, y + 58, { width: 170, align: 'center' });

    doc.fillColor(COLOR.ink);
  }

  /** Sello de anulada: tiene que verse a primera vista, no en la letra pequeña. */
  private renderCancelledStamp(doc: PDFKit.PDFDocument): void {
    doc.save();
    doc
      .rotate(-20, { origin: [PAGE.width / 2, 400] })
      .font('Helvetica-Bold')
      .fontSize(64)
      .fillColor(COLOR.danger)
      .opacity(0.16)
      .text('ANULADA', 0, 370, { width: PAGE.width, align: 'center' })
      .opacity(1);
    doc.restore();
    doc.fillColor(COLOR.ink);
  }

  // ── Pie de página ──────────────────────────────────────────

  private renderFooters(
    doc: PDFKit.PDFDocument,
    store: StoreInfo,
    invoice: InvoiceForPdf,
  ): void {
    const range = doc.bufferedPageRange();

    for (let index = 0; index < range.count; index++) {
      doc.switchToPage(range.start + index);

      doc.rect(0, FOOTER_TOP, PAGE.width, FOOTER_BAND_HEIGHT).fill(COLOR.black);
      // Acento naranja en diagonal, como en la cabecera.
      doc
        .polygon(
          [0, FOOTER_TOP],
          [128, FOOTER_TOP],
          [88, PAGE.height],
          [0, PAGE.height],
        )
        .fill(COLOR.red);

      const contact = [store.phone, store.address, ...Object.values(store.social)]
        .filter(Boolean)
        .join('   ·   ');

      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(COLOR.white)
        .text('Gracias por su compra', 150, FOOTER_TOP + 12, {
          width: PAGE.width - 200,
          align: 'left',
        });

      if (contact) {
        doc
          .font('Helvetica')
          .fontSize(7.5)
          .fillColor('#C3C8D4')
          .text(contact, 150, FOOTER_TOP + 26, { width: PAGE.width - 200, align: 'left' });
      }

      doc
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor('#C3C8D4')
        .text(
          range.count > 1
            ? `${invoice.number}  ·  Pág. ${index + 1}/${range.count}`
            : invoice.number,
          PAGE.width - MARGIN - 150,
          FOOTER_TOP + 19,
          { width: 150, align: 'right' },
        );
    }
  }
}
