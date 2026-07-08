from odoo import fields, models


class PosConfig(models.Model):
    _inherit = 'pos.config'

    guper_store_id = fields.Char(
        string="ID de tienda Guper",
        help="storeId enviado a Guper. Si está vacío, usa el id de esta tienda (pos.config).")
    guper_interface = fields.Char(
        string="Interfaz Guper", default='odoo',
        help="Identificador de la interfaz de venta enviado a Guper.")
    guper_pin_threshold = fields.Integer(
        string="Umbral para exigir PIN (centavos)", default=0,
        help="0 = siempre exige PIN en el canje. >0 = solo exige por encima de este monto.")
    guper_cashback_product_id = fields.Many2one(
        'product.product', string="Producto Cashback (línea de descuento)",
        help="Producto de servicio usado como línea de descuento negativa del canje.")

    def _guper_store_id(self):
        # storeId = id da loja na Odoo (pos.config), com override manual opcional.
        self.ensure_one()
        return self.guper_store_id or str(self.id)
