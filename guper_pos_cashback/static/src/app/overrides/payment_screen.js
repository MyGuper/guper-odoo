/** @odoo-module **/
import { patch } from "@web/core/utils/patch";
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";

// Ao fechar a venta, confirma em Guper (acumulacao + resgate) com o token
// fresco obtido no clique em "Pagar" (pay_flow). NAO bloqueia o fechamento
// ante erros: o cron reintenta a acumulacao.
patch(PaymentScreen.prototype, {
    async validateOrder(isForceValidate) {
        const order = this.currentOrder;
        const orderRef = order && order.guper_order_ref;
        if (orderRef) {
            try {
                await this._guperCall("/guper/redeem/confirm", {
                    order_uuid: orderRef,
                    amount_to_redeem: order.guper_redeem_amount || 0,
                });
            } catch (e) {
                this.env.services.notification.add(
                    "Guper: " + (e.message || "no se pudo confirmar"),
                    { type: "warning" }
                );
            }
        }
        return super.validateOrder(isForceValidate);
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
                    "error"
            );
        }
        return data.result;
    },
});
