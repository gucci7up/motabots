# Contabilidad administrativa

> Diseño de referencia para la Fase 10. No es contabilidad fiscal ni partida doble completa:
> es la contabilidad administrativa necesaria para saber cuánto se vendió, cuánto costó y
> cuánto quedó.

## Qué responde

- Ingresos del período
- Costo de ventas
- Utilidad bruta
- Gastos
- Utilidad neta
- Cuentas por cobrar
- Efectivo en caja
- Valor del inventario

## Fórmulas

```
Ingresos       = Σ sale_items.total            (ventas COMPLETED del período)
Costo de ventas= Σ sale_items.quantity × sale_items.unitCostSnapshot
Utilidad bruta = Ingresos − Costo de ventas
Gastos         = Σ expenses.amount             (del período)
Utilidad neta  = Utilidad bruta − Gastos
```

Reglas que no se negocian:

1. **El costo sale del snapshot**, nunca del `costPrice` actual de la variante. Si mañana sube
   el costo de compra, la utilidad de las ventas de ayer no cambia.
2. **Las ventas canceladas no cuentan**: se filtra `saleStatus = COMPLETED`.
3. **Ingreso ≠ cobro.** Una venta a crédito es ingreso del día en que se vendió; el cobro
   aparece en caja el día del abono. Confundirlos es lo que hace que «vendí mucho» y «no tengo
   efectivo» parezcan contradictorios cuando no lo son.
4. **Los descuentos reducen el ingreso**, no aumentan el costo.

## Cuentas por cobrar

```
Por cobrar = Σ credit_accounts.balance  WHERE status IN (PENDING, PARTIAL, OVERDUE)
Vencido    = idem  WHERE dueDate < hoy
```

No hay campo `balance` en `customers`: se calcula. Un saldo guardado a mano se desincroniza y
deja de ser confiable justo cuando más importa.

## Caja

```
expectedCash = openingAmount + Σ movimientos IN − Σ movimientos OUT
difference   = actualCash − expectedCash
```

La diferencia se registra en el cierre y no se «corrige» borrando movimientos.

## Inventario

```
Valor del inventario = Σ (product_variants.currentStock × product_variants.costPrice)
```

Valuación a **costo estándar** (el `costPrice` vigente de la variante). Los movimientos de
compra guardan su propio `unitCost`, así que migrar a costo promedio ponderado o FIFO más
adelante es un cambio de servicio, no de esquema.

## accounting_entries

Cada operación financiera deja un asiento con `type`, `amount`, `referenceType` y
`referenceId`:

| Operación | Asientos |
|-----------|----------|
| Venta | `REVENUE` (total) + `COST_OF_GOODS_SOLD` (costo) |
| Venta a crédito | además `CREDIT_ISSUED` (saldo) |
| Abono | `CREDIT_COLLECTED` + `CASH_IN` si fue efectivo |
| Gasto | `EXPENSE` + `CASH_OUT` si fue efectivo |
| Entrada de inventario | `INVENTORY_IN` |
| Ajuste de inventario | `INVENTORY_ADJUSTMENT` |
| Cancelación de venta | asientos inversos, nunca borrado |

Los asientos son append-only. La tabla está pensada para admitir un futuro
`accounting_entry_lines` con débito/haber y pasar a partida doble sin rehacer el histórico.

## Impuestos

`tax.enabled` viene en `false`. El modelo ya lleva `taxAmount` en ventas y facturas y los
campos fiscales (`fiscalType`, `fiscalNumber`, `fiscalSequenceId`, `customerTaxId`) más la
tabla `fiscal_sequences` para NCF/e-CF.

**Decisión pendiente antes de activarlo:** si los precios de venta se consideran con ITBIS
incluido o sin él. Cambia el cálculo de todos los totales y no debe decidirse a mitad de un
período contable.

## Zona horaria

Todo se guarda en UTC. Los cortes de reportes y cierres de caja usan `America/Santo_Domingo`
(UTC−4, sin horario de verano). Sin esto, una venta de las 9 PM aparecería en el día siguiente.
