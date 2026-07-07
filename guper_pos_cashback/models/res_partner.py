import re

from odoo import fields, models


class ResPartner(models.Model):
    _inherit = 'res.partner'

    guper_person_id = fields.Char(
        string="Guper Person ID", index=True, copy=False,
        help="Caché del personId de Guper resuelto por el celular/documento.")

    def _guper_digits(self, value):
        return re.sub(r'\D', '', value or '')

    def _guper_client_dict(self):
        """Monta o objeto `client` do reward-by-order a partir do partner.

        O documento e a chave primaria de match; celular e email ajudam. Se ja
        houver guper_person_id cacheado, o resolve() usa direto o personId.
        """
        self.ensure_one()
        # Odoo 19 removeu res.partner.mobile (consolidado em phone). getattr
        # mantem compatibilidade com a 18 (que ainda tem mobile).
        cellphone = self._guper_digits(getattr(self, 'mobile', False) or self.phone)
        client = {}
        if self.guper_person_id:
            # personId inteiro tem prioridade (match direto).
            try:
                return int(self.guper_person_id)
            except (ValueError, TypeError):
                pass
        if self.ref:
            client['id'] = self.ref
        if self.name:
            client['name'] = self.name
        # TODO(guper): mapear o campo de documento fiscal (l10n_*/vat) da instancia.
        if self.vat:
            client['document'] = self._guper_digits(self.vat)
        if self.email:
            client['email'] = self.email.lower()
        if cellphone:
            client['cellphone'] = cellphone
            # TODO(guper): countryCallingCode herdado da org se omitido; ajustar se multi-pais.
        return client or None

    def _guper_cache_person(self, person_id):
        if person_id and str(person_id) != (self.guper_person_id or ''):
            self.sudo().write({'guper_person_id': str(person_id)})
