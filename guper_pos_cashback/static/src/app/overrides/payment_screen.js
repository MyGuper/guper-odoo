/** @odoo-module **/
import { patch } from "@web/core/utils/patch";
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { _t } from "@web/core/l10n/translation";

// Ponto de commit do resgate: confirmOrder no FECHAMENTO (nao ao aplicar a
// linha de desconto), para evitar debitar saldo de um carrinho abandonado.
// Como o confirmToken tem expiresAt curto, isto exige o POS online.
// TODO(guper): confirmar o nome do hook de validacao no build 18 instalado.
//   Em alguns point-releases e `validateOrder(isForceValidate)`, noutros o
//   commit fica melhor em `_finalizeValidation()`. Ajustar conforme a fonte.
patch(PaymentScreen.prototype, {
    async validateOrder(isForceValidate) {
        const order = this.currentOrder;
        const redeem = order?.guper_redeem_amount || 0;
        const partner = order?.get_partner();

        if (redeem > 0) {
            // RESGATE: confirma o debito (usa o confirmToken da sessao). NAO pode
            // fechar sem confirmacao -> em caso de falha, aborta a validacao.
            try {
                await this._guperCall("/guper/redeem/confirm", {
                    order_uuid: order.uuid,
                    amount_to_redeem: redeem,
                });
            } catch (e) {
                this.env.services.notification.add(
                    _t("Nao foi possivel confirmar o resgate. Verifique a conexao."),
                    { type: "danger" }
                );
                return; // aborta a validacao
            }
        } else if (partner) {
            // ACUMULO em tempo real: reward-by-order + confirmOrder(0) na hora.
            // Nao bloqueia: se falhar (offline/erro), o cron assume depois.
            try {
                await this._guperCall("/guper/accrue", {
                    order_uuid: order.uuid,
                    config_id: this.pos.config.id,
                    partner_id: partner.id,
                    items: this._guperItems(order),
                });
            } catch (e) {
                // silencioso: fallback assincrono via _cron_guper_accruals
            }
        }
        return super.validateOrder(isForceValidate);
    },

    _guperItems(order) {
        const cashbackId = (this.pos.config.guper_cashback_product_id || [])[0];
        return order
            .get_orderlines()
            .filter((l) => l.product.id !== cashbackId && l.quantity > 0)
            .map((l) => ({
                id: l.product.default_code || String(l.product.id),
                name: l.product.display_name,
                quantity: Math.round(l.quantity),
                price: Math.round(l.price * 100),
                productId: String(l.product.id),
            }));
    },

    async _guperCall(path, params) {
        const res = await fetch(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", method: "call", params }),
        });
        const data = await res.json();
        if (data.error) {
            throw new Error(data.error.data?.message || data.error.message);
        }
        return data.result;
    },
});
