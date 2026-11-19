from odoo import fields, models


class PosConfig(models.Model):
    _inherit = 'pos.config'

    guper_store_id = fields.Char(
        string="Guper Store ID",
        help="storeId enviado ao Guper. Se vazio, usa o id desta loja (pos.config).")
    guper_interface = fields.Char(
        string="Guper Interface", default='odoo',
        help="Identificador da interface de venda enviado ao Guper.")
    guper_pin_threshold = fields.Integer(
        string="Limite p/ exigir PIN (centavos)", default=0,
        help="0 = sempre exige PIN no resgate. >0 = so exige acima deste valor.")
    guper_cashback_product_id = fields.Many2one(
        'product.product', string="Produto Cashback (linha de desconto)",
        help="Produto servico usado como linha de desconto negativa do resgate.")

    def _guper_store_id(self):
        # Override manual > apikey (que a Guper usa como storeId) > id interno.
        self.ensure_one()
        if self.guper_store_id:
            return self.guper_store_id
        apikey = self.env['ir.config_parameter'].sudo().get_param('guper.apikey')
        return apikey or str(self.id)
