from odoo import fields, models


class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    guper_enabled = fields.Boolean(
        string="Guper ativo", config_parameter='guper.enabled',
        help="Desligado por padrao. Ligue apenas na PRODUCAO. Em staging "
             "(Odoo.sh copia o banco de producao) deixe desligado para nao "
             "gerar cashback nem disparar PIN reais.")
    guper_base_url = fields.Char(
        string="Guper Base URL", config_parameter='guper.base_url',
        help="https://{organizacao}.myguper.com")
    guper_apikey = fields.Char(
        string="Guper API Key", config_parameter='guper.apikey')
    guper_apisecret = fields.Char(
        string="Guper API Secret", config_parameter='guper.apisecret')
