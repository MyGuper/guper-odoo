import logging

from odoo import _, fields, http
from odoo.exceptions import UserError, AccessError
from odoo.http import request

_logger = logging.getLogger(__name__)


class GuperPosController(http.Controller):
    """Proxy do POS para a API Guper. Mantem credenciais/token server-side e,
    crucialmente, impoe que o resgate so seja confirmado apos PIN validado."""

    def _client(self):
        return request.env['guper.client'].sudo()

    def _session(self, order_uuid, config_id=False):
        return request.env['guper.checkout.session'].sudo()._get_or_create(
            order_uuid, config_id=config_id)

    def _guper_cashback_product_id(self, config):
        # Produto da loja, ou o produto padrao criado pelo modulo.
        product = config.guper_cashback_product_id or request.env.ref(
            'guper_pos_cashback.product_guper_cashback', raise_if_not_found=False)
        return product.id if product else False

    # ------------------------------------------ acumulo em tempo real (s/ resgate)
    @http.route('/guper/accrue', type='jsonrpc', auth='user')
    def accrue(self, order_uuid, config_id, partner_id, items):
        """Acumulo sincrono no fechamento para pedidos com cliente e SEM resgate.
        reward-by-order + confirmOrder(0) numa tacada. Se falhar (offline/erro),
        o front ignora e o cron _cron_guper_accruals assume depois."""
        config = request.env['pos.config'].browse(int(config_id))
        partner = request.env['res.partner'].browse(int(partner_id))
        quote = self._client().reward_by_order(
            store_id=config._guper_store_id(),
            interface=config.guper_interface or 'odoo',
            items=items,
            client=partner._guper_client_dict(),
            checkout_id=order_uuid,
        )
        if quote.get('customerId'):
            partner._guper_cache_person(quote['customerId'])
        res = self._client().confirm_order(
            confirm_token=quote['confirmToken'],
            order_id=order_uuid,
            amount_to_redeem=0,
        )
        sess = self._session(order_uuid, config_id=config.id)
        sess.write({
            'partner_id': partner.id,
            'tid': res.get('TID'),
            'accumulated': (res.get('cashback') or {}).get('accumulatedOrder', 0),
            'confirmed': True,
        })
        return {'tid': res.get('TID')}

    # ----------------------------------------------------- 1) cotacao / saldo
    @http.route('/guper/redeem/start', type='jsonrpc', auth='user')
    def redeem_start(self, order_uuid, config_id, partner_id, items):
        """Chama reward-by-order, guarda confirmToken/customerId na sessao e
        devolve saldo + maximo resgatavel para o caixa."""
        config = request.env['pos.config'].browse(int(config_id))
        partner = request.env['res.partner'].browse(int(partner_id))

        quote = self._client().reward_by_order(
            store_id=config._guper_store_id(),
            interface=config.guper_interface or 'odoo',
            items=items,
            client=partner._guper_client_dict(),
            checkout_id=order_uuid,
        )
        this_order = (quote.get('cashback') or {}).get('thisOrder') or {}
        user_balance = (quote.get('cashback') or {}).get('userBalance') or {}
        redeemable = (this_order.get('redeemable') or {}).get('total', 0)
        available = user_balance.get('availableAmount', 0)

        if quote.get('customerId'):
            partner._guper_cache_person(quote['customerId'])

        sess = self._session(order_uuid, config_id=config.id)
        sess.write({
            'partner_id': partner.id,
            'customer_id': str(quote.get('customerId') or partner.guper_person_id or ''),
            'confirm_token': quote.get('confirmToken'),
            'expires_at': self._parse_dt(quote.get('expiresAt')),
            'redeemable_total': redeemable,
            'balance_available': available,
            'pin_validated': False,
        })
        return {
            'redeemable_total': redeemable,
            'balance_available': available,
            'requires_pin': True,
            'pin_threshold': config.guper_pin_threshold or 0,
            # id do produto de cashback vai na resposta (o front nao carrega
            # esse campo da config). Fallback: produto padrao do modulo, para
            # nao depender de config manual por loja/banco.
            'cashback_product_id': self._guper_cashback_product_id(config),
        }

    # ----------------------------------------------------------- 2) gerar PIN
    @http.route('/guper/pin/generate', type='jsonrpc', auth='user')
    def pin_generate(self, order_uuid):
        sess = self._session(order_uuid)
        if not sess.customer_id:
            raise UserError(_("Cliente Guper nao resolvido para este pedido."))
        res = self._client().generate_pin(person_id=sess.customer_id)
        sess.pin_expires_at = self._parse_dt(res.get('expiresAt'))
        # Nao expoe o PIN (nunca retornado); so canal e destino mascarado.
        return {
            'channel': res.get('channel'),
            'sent_to': res.get('sentTo'),
            'expires_at': res.get('expiresAt'),
        }

    # --------------------------------------------------------- 3) validar PIN
    @http.route('/guper/pin/validate', type='jsonrpc', auth='user')
    def pin_validate(self, order_uuid, pin):
        sess = self._session(order_uuid)
        if not sess.customer_id:
            raise UserError(_("Cliente Guper nao resolvido para este pedido."))
        valid = self._client().validate_pin(person_id=sess.customer_id, pin=pin)
        if valid:
            sess.pin_validated = True
        return {'valid': valid}

    # ------------------------------------------------- 4) confirmar (commit)
    @http.route('/guper/redeem/confirm', type='jsonrpc', auth='user')
    def redeem_confirm(self, order_uuid, amount_to_redeem=0):
        """Efetiva acumulo + resgate. GATE: resgate > 0 exige PIN validado
        nesta sessao e respeita o limite/expiresAt do confirmToken."""
        sess = self._session(order_uuid)
        amount = int(amount_to_redeem or 0)

        if not sess.confirm_token:
            raise UserError(_("Sessao Guper sem confirmToken (rode redeem/start)."))
        if sess.expires_at and fields.Datetime.now() > sess.expires_at:
            raise UserError(_("Cotacao Guper expirada. Refaca o resgate."))

        if amount > 0:
            if amount > (sess.redeemable_total or 0):
                raise UserError(_("Valor de resgate acima do permitido."))
            if not sess.pin_validated:
                raise AccessError(_("Resgate exige PIN validado."))

        res = self._client().confirm_order(
            confirm_token=sess.confirm_token,
            order_id=order_uuid,
            amount_to_redeem=amount,
        )
        # Grava o resultado na sessao; o pos.order estampa o TID quando sincroniza.
        tid = res.get('TID')
        accumulated = (res.get('cashback') or {}).get('accumulatedOrder', 0)
        sess.write({'tid': tid, 'accumulated': accumulated, 'confirmed': True})
        return {'tid': tid, 'accumulated': accumulated}

    # ------------------------------------------------------------- utilidades
    @staticmethod
    def _parse_dt(iso):
        if not iso:
            return False
        # "2026-05-01T12:39:56-03:00" -> naive UTC-ish (corta tz e T).
        try:
            return fields.Datetime.to_datetime(iso[:19].replace('T', ' '))
        except (ValueError, TypeError):
            return False
