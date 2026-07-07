/** @odoo-module **/
// Odoo 17: patch do PaymentScreen. API de pedido em snake_case; identificador
// do pedido = order.name (= pos_reference no backend).
import { patch } from "@web/core/utils/patch";
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { _t } from "@web/core/l10n/translation";

patch(PaymentScreen.prototype, {
    async validateOrder(isForceValidate) {
        const order = this.currentOrder;
        const orderRef = order && (order.guper_order_ref || order.name || order.uid);
        const redeem = order?.guper_redeem_amount || 0;
        const partner = order?.get_partner();

        if (redeem > 0) {
            // RESGATE: confirma o debito. Nao pode fechar sem confirmacao.
            try {
                await this._guperCall("/guper/redeem/confirm", {
                    order_uuid: orderRef,
                    amount_to_redeem: redeem,
                });
            } catch (e) {
                this.env.services.notification.add(
                    "Guper: " + (e.message || _t("fallo al confirmar el canje")),
                    { type: "danger" }
                );
                return; // aborta a validacao
            }
        } else if (partner) {
            // ACUMULO em tempo real; se falhar, o cron assume depois.
            try {
                await this._guperCall("/guper/accrue", {
                    order_uuid: orderRef,
                    config_id: this.pos.config.id,
                    partner_id: partner.id,
                    items: this._guperItems(order),
                });
            } catch (e) {
                // silencioso: fallback via _cron_guper_accruals
            }
        }
        return super.validateOrder(isForceValidate);
    },

    _guperItems(order) {
        return order
            .get_orderlines()
            .filter((l) => l.get_quantity() > 0 && (l.get_unit_price() || 0) >= 0)
            .map((l) => {
                const p = l.get_product();
                return {
                    id: p.default_code || String(p.id),
                    name: p.display_name,
                    quantity: Math.round(l.get_quantity()),
                    price: Math.round((l.get_unit_price() || 0) * 100),
                    productId: String(p.id),
                };
            });
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
