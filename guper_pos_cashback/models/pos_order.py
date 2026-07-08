import logging

from odoo import api, fields, models

_logger = logging.getLogger(__name__)


class PosOrder(models.Model):
    _inherit = 'pos.order'

    guper_accrual_state = fields.Selection(
        [('pending', 'Pendiente'), ('sent', 'Enviado'), ('error', 'Error')],
        string="Guper - Acumulación", copy=False)
    guper_redeem_ref = fields.Char(
        string="Guper - TID", copy=False, index=True,
        help="TID retornado por confirmOrder (acumulación/canje efectuado).")
    guper_accumulated = fields.Integer(
        string="Guper - Acumulado (centavos)", copy=False)
    guper_cancel_state = fields.Selection(
        [('pending', 'Pendiente'), ('done', 'Cancelado'), ('error', 'Error')],
        string="Guper - Cancelación", copy=False,
        help="Estado del reverso en Guper para pedidos de devolución (refund).")

    _PAID_STATES = ('paid', 'done', 'invoiced')

    # --------------------------------------------------------- accrual trigger
    # Marcamos o pedido para acumulo assincrono via ORM (estavel entre versoes),
    # sem depender do metodo de sync do POS (que muda entre point-releases da 18).
    # Pedidos que ja tiveram resgate confirmado no caixa (guper_redeem_ref) sao
    # ignorados: o confirmOrder do resgate ja fez o acumulo na mesma chamada.
    def _guper_flag_pending(self):
        for order in self:
            if order.state not in self._PAID_STATES:
                continue
            if order._guper_is_refund():
                # Devolucao -> estorno no Guper (total ou parcial).
                if order.guper_cancel_state not in ('pending', 'done'):
                    order.with_context(guper_skip=True).write(
                        {'guper_cancel_state': 'pending'})
            elif (order.partner_id and not order.guper_redeem_ref
                  and order.guper_accrual_state not in ('pending', 'sent')):
                order.with_context(guper_skip=True).write(
                    {'guper_accrual_state': 'pending'})

    def _guper_is_refund(self):
        self.ensure_one()
        if any(line.refunded_orderline_id for line in self.lines):
            return True
        return self.amount_total < 0

    @api.model_create_multi
    def create(self, vals_list):
        orders = super().create(vals_list)
        if not self.env.context.get('guper_skip'):
            orders._guper_confirm_realtime()
            orders._guper_flag_pending()
        return orders

    def _guper_confirm_realtime(self):
        """Confirma en Guper (acumulación y/o canje) al crearse el pedido en el
        servidor, usando pos_reference como id -> el registro en Guper coincide
        con el número de ticket del POS (y con lo que usa el estorno). El front
        ya dejó en la guper.checkout.session el confirmToken (redeem/start), el
        pin_validated y el amount_to_redeem (redeem/confirm=stash). NO bloquea
        el cobro: ante error, el cron _cron_guper_accruals reintenta el acúmulo."""
        Client = self.env['guper.client']
        if not Client.enabled():
            return  # staging/desligado: nao fala com o Guper
        Session = self.env['guper.checkout.session'].sudo()
        for order in self:
            if order._guper_is_refund():
                continue
            uuid = getattr(order, 'uuid', False)
            if not uuid:
                continue
            sess = Session.search([('order_uuid', '=', uuid)], limit=1)
            if not sess or sess.confirmed or not sess.confirm_token:
                continue
            amount = int(sess.amount_to_redeem or 0)
            if amount > 0 and not sess.pin_validated:
                amount = 0  # seguranca: sem PIN nao resgata, so acumula
            try:
                res = Client.confirm_order(
                    confirm_token=sess.confirm_token,
                    order_id=order.pos_reference,
                    amount_to_redeem=amount,
                )
            except Exception as exc:  # noqa: BLE001 - nao bloqueia o cobro
                _logger.warning("Guper: confirmOrder en create falló (ticket %s): "
                                "%s", order.pos_reference, exc)
                continue
            tid = res.get('TID')
            accumulated = (res.get('cashback') or {}).get('accumulatedOrder', 0)
            order.with_context(guper_skip=True).write({
                'guper_redeem_ref': tid,
                'guper_accrual_state': 'sent',
                'guper_accumulated': accumulated,
            })
            sess.write({'tid': tid, 'accumulated': accumulated, 'confirmed': True})

    def write(self, vals):
        res = super().write(vals)
        if 'state' in vals and not self.env.context.get('guper_skip'):
            self._guper_flag_pending()
        return res

    # ----------------------------------------------------------------- helpers
    def _guper_items(self):
        """Linhas do pedido em formato Guper (centavos), excluindo a linha de
        desconto de cashback (que e resgate, nao produto)."""
        self.ensure_one()
        cashback_product = self.config_id.guper_cashback_product_id
        items = []
        for line in self.lines:
            if cashback_product and line.product_id == cashback_product:
                continue
            if line.qty <= 0:
                continue
            # Base de acumulacion = valor CON impuesto (lo que paga el cliente),
            # no el price_unit sin IVA. price_subtotal_incl ya trae el impuesto
            # y el descuento de linea; lo pasamos a precio unitario con impuesto.
            unit_with_tax = (line.price_subtotal_incl / line.qty
                             if line.qty else line.price_subtotal_incl)
            items.append({
                'id': line.product_id.default_code or str(line.product_id.id),
                'name': line.product_id.display_name,
                'quantity': int(line.qty),
                'price': int(round(unit_with_tax * 100)),
                'productId': str(line.product_id.id),
            })
        return items

    # ----------------------------------------------------------- accrual cron
    def _cron_guper_accruals(self, limit=200):
        """Processa acumulos pendentes (pedidos sem resgate). Idempotente via
        checkoutId = pos_reference. Como nao ha resgate, re-cotar e seguro."""
        Client = self.env['guper.client']
        if not Client.enabled():
            return  # staging/desligado: nao fala com o Guper
        orders = self.search(
            [('guper_accrual_state', '=', 'pending')], limit=limit)
        for order in orders:
            try:
                config = order.config_id
                client = order.partner_id._guper_client_dict()
                quote = Client.reward_by_order(
                    store_id=config._guper_store_id(),
                    interface=config.guper_interface or 'odoo',
                    items=order._guper_items(),
                    client=client,
                    checkout_id=order.pos_reference,
                )
                if quote.get('customerId'):
                    order.partner_id._guper_cache_person(quote['customerId'])
                res = Client.confirm_order(
                    confirm_token=quote['confirmToken'],
                    order_id=order.pos_reference,
                    amount_to_redeem=0,
                )
                order.write({
                    'guper_accrual_state': 'sent',
                    'guper_redeem_ref': res.get('TID'),
                    'guper_accumulated': (res.get('cashback') or {})
                    .get('accumulatedOrder', 0),
                })
            except Exception as exc:  # noqa: BLE001 - registra e segue
                order.guper_accrual_state = 'error'
                _logger.exception("Guper: falha no acumulo do pedido %s: %s",
                                  order.pos_reference, exc)

    # ---------------------------------------------------------- refund/estorno
    def _guper_original_order(self):
        """Pedido original referenciado por uma devolucao (via linha estornada).
        TODO(guper): assume um unico pedido de origem por devolucao."""
        self.ensure_one()
        for line in self.lines:
            if line.refunded_orderline_id:
                return line.refunded_orderline_id.order_id
        return self.browse()

    def _guper_refund_qty_by_product(self):
        """Quantidades devolvidas (positivas) por produto neste refund."""
        self.ensure_one()
        cashback = self.config_id.guper_cashback_product_id
        qty = {}
        for line in self.lines:
            if cashback and line.product_id == cashback:
                continue
            if line.qty >= 0:
                continue  # so linhas negativas (devolucao)
            qty[line.product_id] = qty.get(line.product_id, 0) + abs(line.qty)
        return qty

    def _guper_refund_items(self):
        """Itens a cancelar no formato do cancelPartial (centavos)."""
        self.ensure_one()
        items = []
        for product, quantity in self._guper_refund_qty_by_product().items():
            items.append({
                'id': product.default_code or str(product.id),
                'quantity': int(round(quantity)),
                'price': int(round(product.lst_price * 100)),
            })
        return items

    def _guper_is_full_refund(self, original):
        """True se este refund devolve 100% de cada linha (nao-cashback) do
        pedido original. TODO(guper): nao acumula refunds parciais anteriores."""
        cashback = self.config_id.guper_cashback_product_id
        refunded = self._guper_refund_qty_by_product()
        for line in original.lines:
            if cashback and line.product_id == cashback:
                continue
            if line.qty <= 0:
                continue
            if refunded.get(line.product_id, 0) < line.qty:
                return False
        return True

    def _cron_guper_cancellations(self, limit=200):
        """Processa devolucoes: estorna acumulo/resgate no Guper. Idempotente
        (cancel_total trata 409). Resolve o TID pelo pedido original ou via
        transaction/byOrder."""
        Client = self.env['guper.client']
        if not Client.enabled():
            return  # staging/desligado: nao fala com o Guper
        refunds = self.search(
            [('guper_cancel_state', '=', 'pending')], limit=limit)
        for refund in refunds:
            try:
                original = refund._guper_original_order()
                interface = (original.config_id.guper_interface
                             or refund.config_id.guper_interface or 'odoo')
                tid = original.guper_redeem_ref
                if not tid and original:
                    data = Client.transaction_by_order(
                        interface=interface,
                        order_ref=original.pos_reference)
                    active = [t for t in data.get('transactions', [])
                              if not t.get('canceledAt')]
                    tid = active[-1]['TID'] if active else None
                if not tid:
                    refund.guper_cancel_state = 'error'
                    _logger.warning("Guper: sem TID para estornar refund %s",
                                    refund.pos_reference)
                    continue

                if original and refund._guper_is_full_refund(original):
                    Client.cancel_total(tid=tid)
                else:
                    Client.cancel_partial(
                        tid=tid, items=refund._guper_refund_items())
                refund.guper_cancel_state = 'done'
            except Exception as exc:  # noqa: BLE001
                refund.guper_cancel_state = 'error'
                _logger.exception("Guper: falha ao estornar refund %s: %s",
                                  refund.pos_reference, exc)
