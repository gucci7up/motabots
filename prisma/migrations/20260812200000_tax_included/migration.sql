-- ITBIS con precios que ya lo incluyen, y recargo por pago con tarjeta.
--
-- La restricción original asumía que el impuesto se suma encima del subtotal
-- (total = subtotal - descuento + impuesto). Con precios que ya lo incluyen, el total ES el
-- subtotal menos el descuento, y el impuesto es la porción contenida en ese total.
-- La bandera por venta permite convivir con las ventas ya registradas sin reescribirlas.
--
-- El recargo por tarjeta sí se suma al total en ambos casos: es dinero adicional que el
-- cliente paga, no una porción del precio.

ALTER TABLE "sales" ADD COLUMN "taxIncluded" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "sales" ADD COLUMN "surcharge" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "invoices" ADD COLUMN "taxIncluded" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "invoices" ADD COLUMN "surcharge" DECIMAL(14,2) NOT NULL DEFAULT 0;

ALTER TABLE "sales" DROP CONSTRAINT "sales_total_check";

ALTER TABLE "sales" ADD CONSTRAINT "sales_total_check" CHECK (
  ("taxIncluded" = false AND "total" = "subtotal" - "discount" + "surcharge" + "taxAmount")
  OR
  ("taxIncluded" = true AND "total" = "subtotal" - "discount" + "surcharge")
);

-- El impuesto contenido nunca puede superar al propio total.
ALTER TABLE "sales" ADD CONSTRAINT "sales_tax_within_total_check"
  CHECK ("taxAmount" >= 0 AND "taxAmount" <= "total");

ALTER TABLE "sales" ADD CONSTRAINT "sales_surcharge_check"
  CHECK ("surcharge" >= 0);
