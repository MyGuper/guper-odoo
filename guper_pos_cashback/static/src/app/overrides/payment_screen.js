/** @odoo-module **/
import { patch } from "@web/core/utils/patch";
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { _t } from "@web/core/l10n/translation";

// Commit do resgate/acumulo no FECHAMENTO (nao ao aplicar a linha de desconto),
// para nao debitar saldo de um carrinho abandonado. Como o confirmToken tem
// expiresAt curto, exige POS online. API do Odoo 19 (getPartner/getOrderlines).
patch(PaymentScreen.prototype, {
    async validateOrder(isForceValidate) {
        const order = this.currentOrder;
        const redeem = order?.guper_redeem_amount || 0;
        const partner = order?.getPartner();

        if (redeem > 0) {
            // RESGATE: confirma o debito (confirmToken da sessao). NAO pode
            // fechar sem confirmacao -> em caso de falha, aborta a validacao.
            try {
                await this._guperCall("/guper/redeem/confirm", {
                    order_uuid: order.uuid,
                    amount_to_redeem: redeem,
                });
            } catch (e) {
                this.env.services.notification.add(
                    "Guper: " + (e.message || _t("fallo al confirmar el canje")),
                    { type: "danger", sticky: true }
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
        // Exclui a linha de desconto de cashback (preco negativo). API 19.
        return order
            .getOrderlines()
            .filter((l) => l.getQuantity() > 0 && (l.price_unit || 0) >= 0)
            .map((l) => ({
                id: l.product_id?.default_code || String(l.product_id?.id),
                name: l.product_id?.display_name,
                quantity: Math.round(l.getQuantity()),
                price: Math.round((l.price_unit || 0) * 100),
                productId: String(l.product_id?.id),
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
            throw new Error(
                data.error.data?.message ||
                    data.error.data?.arguments?.[0] ||
                    data.error.message ||
                    "error desconocido"
            );
        }
        return data.result;
    },
});
