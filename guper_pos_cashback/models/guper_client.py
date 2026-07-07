import logging
import requests

from odoo import _, api, fields, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

TIMEOUT = 10


class GuperClient(models.AbstractModel):
    """Cliente HTTP fino para a API Guper.

    Endpoints usados (todos em https://{org}.myguper.com):
      - GET  /api/connect/token                                  -> auth (token cache)
      - POST /api/loyalty/checkout/reward-by-order               -> cotacao (confirmToken)
      - POST /api/loyalty/confirmOrder/{confirmToken}            -> commit (acumulo + resgate)
      - GET  /api/register/customer/{person}/pin                 -> gera PIN (WhatsApp/SMS)
      - POST /api/register/customer/{person}/pin/validate        -> valida PIN

    Credenciais e base_url ficam em ir.config_parameter (system parameters):
      guper.base_url, guper.apikey, guper.apisecret
    O token e a validade sao cacheados em: guper.access_token, guper.token_expires_in
    """
    _name = 'guper.client'
    _description = 'Guper API Client'

    # ------------------------------------------------------------------ infra
    def _icp(self):
        return self.env['ir.config_parameter'].sudo()

    def enabled(self):
        """Trava de seguranca. Desligada por padrao: em Odoo.sh o staging copia
        o banco de producao (credenciais inclusas), entao so producao deve falar
        com o Guper. Ligue 'guper.enabled' = True apenas na producao."""
        val = self._icp().get_param('guper.enabled', 'False')
        return str(val).strip().lower() in ('true', '1', 't')

    def _check_enabled(self):
        if not self.enabled():
            raise UserError(_(
                "Integracao Guper desativada (guper.enabled = False)."))

    def _base(self):
        base = self._icp().get_param('guper.base_url')
        if not base:
            raise UserError(_("Parametro 'guper.base_url' nao configurado."))
        return base.rstrip('/')

    def _token(self):
        icp = self._icp()
        tok = icp.get_param('guper.access_token')
        exp = icp.get_param('guper.token_expires_in')
        # Renova com 60s de margem antes de expirar.
        if tok and exp:
            try:
                expires = fields.Datetime.to_datetime(exp[:19].replace('T', ' '))
                if expires and fields.Datetime.now() < expires:
                    return tok
            except (ValueError, TypeError):
                pass
        r = requests.get(
            f"{self._base()}/api/connect/token",
            headers={
                'x-guper-apikey': icp.get_param('guper.apikey') or '',
                'x-guper-apisecret': icp.get_param('guper.apisecret') or '',
                'Content-Type': 'application/json',
            },
            timeout=TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
        icp.set_param('guper.access_token', data['accessToken'])
        # expiresIn vem como timestamp ISO com timezone; guardamos como naive UTC-ish.
        icp.set_param('guper.token_expires_in', data['expiresIn'])
        return data['accessToken']

    def _headers(self):
        return {
            'x-guper-authorization': self._token(),
            'Content-Type': 'application/json',
        }

    def _post(self, path, body):
        self._check_enabled()
        r = requests.post(f"{self._base()}{path}", json=body,
                          headers=self._headers(), timeout=TIMEOUT)
        r.raise_for_status()
        return r.json()

    def _get(self, path):
        self._check_enabled()
        r = requests.get(f"{self._base()}{path}",
                         headers=self._headers(), timeout=TIMEOUT)
        r.raise_for_status()
        return r.json()

    # -------------------------------------------------------------- endpoints
    def reward_by_order(self, *, store_id, interface, items, client=None,
                        checkout_id=None, attendants=None):
        """Fase 1 - cotacao. Modo privado (com token) retorna customerId,
        cashback.redeemable/accumulating, userBalance e confirmToken."""
        body = {
            'storeId': store_id,
            'interface': interface,
            'items': items,
        }
        if client is not None:
            body['client'] = client
        if checkout_id:
            body['checkoutId'] = checkout_id
        if attendants:
            body['attendants'] = attendants
        return self._post('/api/loyalty/rewardByOrder', body)

    def confirm_order(self, *, confirm_token, order_id, amount_to_redeem=0,
                      payments=None, client=None, wait_settlement=False):
        """Fase 2 - commit. Confirma acumulo e resgate (amountToRedeem) juntos.
        Retorna TID, cashback.accumulatedOrder, person."""
        body = {'id': order_id, 'amountToRedeem': int(amount_to_redeem or 0)}
        if wait_settlement:
            body['waitSettlement'] = True
        if client:
            body['client'] = client
        if payments:
            body['payments'] = payments
        return self._post(f"/api/loyalty/confirmOrder/{confirm_token}", body)

    def transaction_by_order(self, *, interface, order_ref):
        """Busca as transacoes de um pedido pelo refId externo (nosso
        pos_reference). Retorna {order, transactions:[{TID, canceledAt, ...}]}."""
        return self._get(
            f"/api/loyalty/{interface}/transaction/byOrder/{order_ref}")

    def cancel_total(self, *, tid):
        """Cancelamento total: reverte acumulo e desfaz resgate. Idempotente:
        409 (ja cancelada) e tratado como sucesso."""
        try:
            return self._post(f"/api/loyalty/cancelOrderByTransaction/{tid}", {})
        except requests.HTTPError as exc:
            if exc.response is not None and exc.response.status_code == 409:
                return {'TID': tid, 'already_canceled': True}
            raise

    def cancel_partial(self, *, tid, items):
        """Cancelamento parcial: reverte acumulo/resgate proporcional aos itens.
        Recomendado reenviar todos os itens cancelados (id/SKU + quantity + price)."""
        return self._post(f"/api/loyalty/cancelPartial/{tid}", {'items': items})

    def generate_pin(self, *, person_id):
        """Dispara PIN por WhatsApp/SMS. Retorna {channel, sentTo, expiresAt}."""
        return self._get(f"/api/register/customer/{person_id}/pin")

    def validate_pin(self, *, person_id, pin):
        """Valida PIN de 4 digitos. Retorna bool."""
        res = self._post(f"/api/register/customer/{person_id}/pin/validate",
                         {'pin': pin})
        return bool(res.get('valid'))
