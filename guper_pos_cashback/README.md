# guper_pos_cashback

Geracao e resgate de cashback **Guper** no Point of Sale do Odoo 18 Enterprise (self-hosted), com autenticacao forte do cliente por **PIN via WhatsApp**.

## Fluxo

```
connect/token (auth, cache server-side)
        │
reward-by-order  ── cotacao: customerId, redeemable, userBalance, confirmToken
        │
   (se resgate > 0)  pin/generate (WhatsApp) → pin/validate  ── PIN sempre exigido
        │
confirmOrder(confirmToken, {id, amountToRedeem})  ── commit acumulo + resgate → TID
```

- **Acumulo puro** (sem resgate): **tempo real** no fechamento via `/guper/accrue`
  (reward-by-order + confirmOrder(0)) para pedidos com cliente. Se falhar (offline),
  cai no cron `_cron_guper_accruals` (idempotente por `checkoutId`). O TID confirmado
  fica na `guper.checkout.session` e o `pos.order` estampa no sync (via uuid).
- **Resgate**: sincrono no caixa (exige online). PIN de 4 digitos, janela de **5 min**, com reenvio.
- **Enforcement do PIN e server-side** (controller): `validate_pin` so retorna booleano, entao o resgate so e confirmado se `guper.checkout.session.pin_validated` for True. O front do POS nao e a barreira.

## Deploy (Odoo.sh)

Instalacao e via **Git**: o modulo vai como pasta raiz do repositorio conectado
ao projeto Odoo.sh. Push numa branch **staging** -> build automatico -> testar ->
merge em **production**. Nao ha copia manual para `addons/`. Unica dependencia
externa e `requests` (ja incluida no ambiente Odoo.sh).

**ATENCAO staging**: o Odoo.sh duplica o banco de producao (com `guper.*`),
entao um teste em staging bateria na org Guper de PRODUCAO (cashback e PIN
reais). Por isso existe a trava `guper.enabled` (ver abaixo), desligada por
padrao. Ligue-a **somente em producao**.

## Configuracao

0. **Ajustes > POS > Guper API > "Guper ativo"**: `guper.enabled`. Desligado por
   padrao; ligue apenas na producao. Com ele desligado, nenhum endpoint Guper e
   chamado (crons saem quietos; chamadas diretas levantam erro claro).
1. **Ajustes > POS > Guper API**: `base_url` (`https://{org}.myguper.com`), `apikey`, `apisecret`.
2. **Cada POS (pos.config) > aba Guper**: `guper_store_id`, `guper_interface` (default `odoo`), `guper_pin_threshold` (0 = PIN sempre), `guper_cashback_product_id` (usar o produto "Cashback Guper" criado pelo modulo).

Todos os valores monetarios em **centavos**.

## Endpoints ligados

| Guper | Uso |
|---|---|
| `GET /api/connect/token` | auth, token cacheado em ir.config_parameter |
| `POST /api/loyalty/checkout/reward-by-order` | cotacao |
| `POST /api/loyalty/confirmOrder/{confirmToken}` | commit |
| `GET /api/register/customer/{person}/pin` | gera PIN |
| `POST /api/register/customer/{person}/pin/validate` | valida PIN |
| `GET /api/loyalty/{interface}/transaction/byOrder/{refId}` | resolve TID pelo pedido |
| `POST /api/loyalty/cancelOrderByTransaction/{TID}` | estorno total (409 = idempotente) |
| `POST /api/loyalty/cancelPartial/{TID}` | estorno parcial (por itens) |

## Refund / estorno

Pedido de devolucao no POS (linhas com `refunded_orderline_id`) e detectado e
enfileirado (`guper_cancel_state`); o cron `_cron_guper_cancellations` resolve o
TID (campo `guper_redeem_ref` do pedido original, ou `transaction/byOrder`) e
chama **cancel total** (devolucao integral) ou **cancel parcial** (itens
devolvidos). `storeId` = id da loja na Odoo (pos.config) com override opcional;
`interface` = `odoo`.

## Entrada no fluxo

O fluxo Guper roda no clique em **Pagar** (`Order.pay()` via `pay_flow.js`), nao como botao separado. Ramos:

- **Com saldo** → popup de monto + PIN + desconto por linha (`set_discount`, aditivo, base = valor COM imposto via `get_price_with_tax()`).
- **Sem saldo** → notificacao de acumulacao (cron assume depois).
- **Anonimo** → notificacao; venda registrada sem cliente.
- **Sem campo identificador** → notificacao; nao acumula.

O `confirmOrder` roda em `PaymentScreen.validateOrder` (via `/guper/redeem/confirm`), depois que o caixa fecha o pagamento. O `pos.order.create()` le o TID da sessao e estampa no pedido (`_guper_apply_realtime_result`). Acumulacao pura (sem resgate): sempre via cron `_cron_guper_accruals` (idempotente por `pos_reference`).

## TODOs em aberto

- [ ] **Documento fiscal**: `res_partner._guper_client_dict` usa `vat`; ajustar para o campo l10n da instancia do cliente (ex.: RFC no Mexico).
- [ ] **Refund cumulativo**: `_guper_is_full_refund` nao soma devolucoes parciais anteriores ao decidir total vs parcial.
- [ ] **Import Order (18)**: `pay_flow.js` importa de `@point_of_sale/app/store/models`; confirmar no build 18 instalado (pode estar em `@point_of_sale/app/models/pos_order`).
```
