from odoo import api, fields, models


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
    guper_cashback_product_ref = fields.Integer(
        string="Guper Cashback Product Ref",
        compute='_compute_guper_cashback_ref',
        help="Id do produto de cashback, carregado no front do POS "
             "(sem arrastar a relacao Many2one, que quebra o load na 19).")

    @api.depends('guper_cashback_product_id')
    def _compute_guper_cashback_ref(self):
        for config in self:
            config.guper_cashback_product_ref = config.guper_cashback_product_id.id or 0

    def _guper_store_id(self):
        # storeId = id da loja na Odoo (pos.config), com override manual opcional.
        self.ensure_one()
        return self.guper_store_id or str(self.id)

    def _load_pos_data_fields(self, *args):
        # Odoo 19: so o id do produto (inteiro) vai pro front. NAO carregar o
        # Many2one guper_cashback_product_id (arrasta pricelist/currency e
        # quebra o processServerData da 19). store_id/interface sao server-side.
        return super()._load_pos_data_fields(*args) + ['guper_cashback_product_ref']
