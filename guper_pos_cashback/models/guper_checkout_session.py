from odoo import api, fields, models


class GuperCheckoutSession(models.Model):
    """Estado efemero de um checkout POS, amarrado pelo uuid da order.

    Guarda o confirmToken e o customerId devolvidos pelo reward-by-order e o
    flag pin_validated. Serve como fonte da verdade server-side: o resgate so e
    confirmado se pin_validated for True para esta sessao (o front do POS nao e
    confiavel para isso, ja que validate_pin so devolve um booleano).
    """
    _name = 'guper.checkout.session'
    _description = 'Guper POS Checkout Session'

    order_uuid = fields.Char(required=True, index=True)
    user_id = fields.Many2one('res.users', required=True, index=True,
                              default=lambda self: self.env.user)
    config_id = fields.Many2one('pos.config')
    partner_id = fields.Many2one('res.partner')

    customer_id = fields.Char(help="personId resuelto por reward-by-order")
    confirm_token = fields.Char()
    expires_at = fields.Datetime(help="expiresAt del confirmToken")

    redeemable_total = fields.Integer(help="Máximo canjeable en este pedido (centavos)")
    balance_available = fields.Integer(help="Saldo disponible del cliente (centavos)")
    amount_to_redeem = fields.Integer(
        default=0,
        help="Monto a canjear stasheado por el front; se confirma server-side "
             "en pos.order.create() con el pos_reference como id.")

    pin_validated = fields.Boolean(default=False)
    pin_expires_at = fields.Datetime(help="expiresAt del último PIN generado")

    # Resultado do confirmOrder feito em tempo real (acumulo e/ou resgate).
    # O pos.order estampa esses valores quando sincroniza (via uuid).
    tid = fields.Char(help="TID retornado por confirmOrder")
    accumulated = fields.Integer(help="cashback.accumulatedOrder (centavos)")
    confirmed = fields.Boolean(default=False)

    # Odoo 19: _sql_constraints foi substituido por models.Constraint.
    _order_user_uniq = models.Constraint(
        'unique(order_uuid, user_id)',
        "Ya existe una sesión Guper para este pedido/usuario.",
    )

    @api.model
    def _get_or_create(self, order_uuid, config_id=False):
        sess = self.search([
            ('order_uuid', '=', order_uuid),
            ('user_id', '=', self.env.uid),
        ], limit=1)
        if not sess:
            sess = self.create({
                'order_uuid': order_uuid,
                'user_id': self.env.uid,
                'config_id': config_id or False,
            })
        return sess

    @api.model
    def _cron_cleanup(self):
        """Remove sessoes expiradas (roda alguns minutos apos o expiresAt)."""
        limit = fields.Datetime.now()
        stale = self.search(['|',
                             ('expires_at', '<', limit),
                             ('expires_at', '=', False)])
        # Mantem por seguranca sessoes criadas ha menos de 1h sem expires_at.
        stale = stale.filtered(
            lambda s: s.expires_at or
            (s.create_date and (limit - s.create_date).total_seconds() > 3600))
        stale.unlink()
