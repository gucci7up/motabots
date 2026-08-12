# Bot de Telegram — diseño

> Diseño de referencia para las fases 2 y 12. La Fase 1 no incluye todavía el módulo de
> Telegram; este documento fija el contrato para que el resto del sistema se construya
> alrededor de él.

## Principio

Telegram es **transporte**, no lógica. Un handler:

1. Interpreta la intención (comando, callback o texto del wizard).
2. Construye un DTO.
3. Llama a un servicio de dominio.
4. Formatea la respuesta.

Nunca consulta la base de datos directamente ni calcula totales por su cuenta. El mismo
`SalesService.create()` que usa el bot lo usará el dashboard web.

## Autenticación

No hay contraseñas. La identidad es el `telegramUserId`:

1. Llega un update con `from.id`.
2. Se busca el usuario activo con ese `telegramUserId`.
3. Si no existe o está inactivo, se responde con un mensaje neutro y se registra el intento.
4. `TELEGRAM_ADMIN_IDS` sirve para el arranque en frío: crea el primer ADMIN por seed.

Cada acción verifica el permiso correspondiente (`sales.create`, `cash.close`, …) antes de
ejecutarse; los botones que el usuario no puede usar no se muestran.

## Modos

- **Desarrollo:** polling.
- **Producción:** webhook en `POST /api/v1/telegram/webhook`, validado contra
  `X-Telegram-Bot-Api-Secret-Token`.

Cada `update_id` se registra en `telegram_updates` antes de procesarse: si Telegram reentrega
el update, se descarta. Sin esto, un timeout de red puede convertirse en una venta duplicada.

## Comandos

| Comando | Acción |
|---------|--------|
| `/start` | Registro/identificación y menú principal |
| `/menu` | Menú principal |
| `/venta` | Wizard de nueva venta |
| `/clientes` | Listado y búsqueda de clientes |
| `/inventario` | Stock y movimientos |
| `/creditos` | Cuentas por cobrar y abonos |
| `/facturas` | Consulta y envío de facturas |
| `/caja` | Abrir, consultar y cerrar caja |
| `/gastos` | Registrar y consultar gastos |
| `/reportes` | Reportes |
| `/ayuda` | Ayuda |

Los comandos son atajos: todo debe poder hacerse con botones.

## Menú principal

```
MOTAPARFUM ADMIN

[📊 Resumen]      [🛒 Ventas]
[👥 Clientes]     [📦 Inventario]
[💳 Créditos]     [🧾 Facturas]
[💰 Caja]         [💸 Gastos]
[📈 Reportes]     [⚙️ Configuración]
```

Toda pantalla que no sea el menú lleva `[⬅️ Atrás]` y `[🏠 Menú]`. Toda acción irreversible
lleva confirmación explícita.

## Wizard de venta

```
Nueva venta
 └─ Cliente: [🔍 Buscar] [➕ Nuevo] [🚶 Sin cliente]
 └─ Productos: búsqueda o navegación por categoría → variante → cantidad
 └─ Carrito: [➕ Agregar] [🗑 Quitar] [💲 Descuento] [✅ Continuar]
 └─ Pago: [💵 Completo] [🧮 Parcial] [💳 Crédito]
 └─ Si hay saldo: fecha de vencimiento (por defecto credit.defaultDueDays)
 └─ Resumen + [✅ CONFIRMAR] [❌ CANCELAR]
```

Ejemplo del resumen:

```
MOTAPARFUM
Cliente: Juan Pérez

2 × Summer Hammer 30ml    RD$1,400.00
1 × Black Opium 30ml        RD$700.00

Total:       RD$2,100.00
Pago:        RD$1,000.00
Crédito:     RD$1,100.00
Vencimiento: 14/08/2026

¿Confirmar?
[✅ CONFIRMAR]  [❌ CANCELAR]
```

El carrito vive en la sesión (Redis con TTL) y **no** es fuente de verdad: hasta que se pulsa
CONFIRMAR no existe ninguna venta. Al confirmar se envía la `idempotencyKey` generada al abrir
el carrito, de modo que un doble tap no crea dos ventas.

## Abonos

`💳 Créditos` → clientes con deuda (paginado) → créditos del cliente → crédito →
`💵 Registrar abono` → monto → método → referencia → confirmación. Al llegar a saldo cero el
crédito pasa a `PAID` dentro de la misma transacción.

## Paginación

Ninguna lista se envía completa. Página de 10 elementos con navegación:

```
[⬅️] [1] [2] [3] [➡️]
```

## Errores

El usuario nunca ve un error técnico. Los errores de negocio muestran su mensaje
(«Stock insuficiente: quedan 2 unidades de Summer Hammer 30ml»); cualquier otro muestra
«❌ No pudimos completar la operación. Inténtalo nuevamente.» y se registra internamente con
su `correlationId`.

## Alertas automáticas

- ⚠️ Stock bajo cuando `currentStock <= minimumStock`.
- 🔴 Créditos vencidos, con días de atraso.
- 📊 Resumen diario a la hora configurada en `alerts.dailySummary.hour`.

## Capa de lenguaje natural (futura)

No es dependencia del núcleo. Cuando se implemente, un parser traducirá
«Vendí dos Summer Hammer de 30ml a Juan por 1400, me dio 500 y el resto el viernes» a un
`CreateSaleDto` y lo presentará como **el mismo resumen de confirmación** de arriba. La IA
propone; el flujo determinístico ejecuta.
