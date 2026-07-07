# Port para Odoo 19 (branch 19.0)

Este branch adapta `guper_pos_cashback` para a versao 19. O **backend** (models,
controllers, guper.client, crons) foi escrito evitando os metodos internos do
POS, entao tende a rodar sem mudanca. O que precisa ser **verificado/ajustado
contra o codigo-fonte do Odoo 19 instalado** esta abaixo.

Regra de ouro: o **log do build do Odoo.sh** na branch 19.0 e o oraculo mais
rapido. Suba, leia o erro, ajuste, `git push` de novo.

## A verificar no Odoo 19

### Front-end OWL (POS) — maior risco
- [ ] Bundle de assets: `point_of_sale._assets_pos` ainda e o nome correto?
      (arquivo: `__manifest__.py`)
- [ ] Import do hook do POS: `@point_of_sale/app/store/pos_hook` (usePos) —
      caminho pode ter mudado. (`cashback_button.js`)
- [ ] `makeAwaitable`: `@point_of_sale/app/store/make_awaitable_dialog` —
      confirmar caminho/nome. (`cashback_button.js`)
- [ ] Registro do botao de controle: categoria
      `pos_screen_control_buttons` — confirmar nome no registry da 19.
      (`cashback_button.js`)
- [ ] Patch do PaymentScreen: import
      `@point_of_sale/app/screens/payment_screen/payment_screen` e o metodo
      `validateOrder(isForceValidate)` — confirmar assinatura/hook. (`payment_screen.js`)
- [ ] `Dialog` de `@web/core/dialog/dialog` e API `getPayload/close` do popup —
      confirmar. (`pin_popup.js`, `pin_popup.xml`)
- [ ] Acesso a produto no POS: `this.pos.db.get_product_by_id` /
      `order.add_product` / `order.get_orderlines` — a camada de dados do POS
      mudou na 18/19; confirmar os metodos. (`cashback_button.js`, `payment_screen.js`)

### Backend — provavelmente estavel, confirmar
- [ ] `pos.order.line.refunded_orderline_id` ainda existe (deteccao de refund).
- [ ] `pos.order.uuid` existe (usado para casar a sessao no sync).
- [ ] `@api.model_create_multi` e override de `create`/`write` sem deprecacao.
- [ ] Campos de `product.product`: `available_in_pos`, `lst_price`,
      `default_code`, `taxes_id` (linha de desconto).

### Traducoes
- [ ] `i18n/es.po`: msgids de campos/erros/JS sao estaveis; textos de template
      QWeb podem mudar — reexportar o .pot pela 19 e mesclar se necessario.

## Estrategia de manutencao 18 <-> 19

Correcoes de logica de negocio (backend) idealmente sao feitas num ponto e
propagadas entre os branches via cherry-pick:

    # exemplo: aplicar no 19.0 um fix feito no 18.0
    git checkout 19.0
    git cherry-pick <commit-do-18.0>

Diferencas que forem so de versao (front OWL, manifest) ficam isoladas em cada
branch e nao devem ser propagadas cegamente.
