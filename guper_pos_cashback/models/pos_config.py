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
        # storeId = id da loja na Odoo (pos.config), com override manual opcional.
        self.ensure_one()
        return self.guper_store_id or str(self.id)

    def _load_pos_data_fields(self, *args):
        # Odoo 19: expõe os campos custom da loja no front do POS.
        return super()._load_pos_data_fields(*args) + [
            'guper_store_id', 'guper_interface',
            'guper_pin_threshold', 'guper_cashback_product_id',
        ]
