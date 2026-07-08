import re

from odoo import fields, models


class ResPartner(models.Model):
    _inherit = 'res.partner'

    guper_person_id = fields.Char(
        string="Guper Person ID", index=True, copy=False,
        help="Caché del personId de Guper resuelto por el celular/documento.")

    def _guper_digits(self, value):
        return re.sub(r'\D', '', value or '')

    def _guper_client_dict(self, id_field=None):
        """Monta o objeto `client` do reward-by-order a partir do partner.

        id_field ('phone'|'email'|'document') define QUAL campo e enviado como
        identificador principal. Se None, le do parametro do sistema global
        'guper.client_id_field' (default 'phone'). name/id vao junto. Se ja
        houver guper_person_id cacheado, retorna direto o personId.
        """
        self.ensure_one()
        if id_field is None:
            id_field = (self.env['ir.config_parameter'].sudo()
                        .get_param('guper.client_id_field', 'phone'))
        if self.guper_person_id:
            try:
                return int(self.guper_person_id)
            except (ValueError, TypeError):
                pass

        # Valor do campo identificador configurado.
        if id_field == 'email':
            key, value = 'email', (self.email or '').strip().lower()
        elif id_field == 'document':
            # TODO(guper): usar o campo l10n da instancia (RFC/CURP) se aplicar.
            key, value = 'document', self._guper_digits(self.vat)
        else:  # phone (padrao) - Odoo 19 removeu mobile; getattr compat com 18.
            key = 'cellphone'
            value = self._guper_digits(getattr(self, 'mobile', False) or self.phone)

        if not value:
            # Sem o campo identificador preenchido -> nao da pra identificar.
            return None

        client = {key: value}
        if self.ref:
            client['id'] = self.ref
        if self.name:
            client['name'] = self.name
        return client

    def _guper_cache_person(self, person_id):
        if person_id and str(person_id) != (self.guper_person_id or ''):
            self.sudo().write({'guper_person_id': str(person_id)})
