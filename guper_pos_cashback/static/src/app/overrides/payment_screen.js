/** @odoo-module **/
// Odoo 17: al cerrar la venta, confirma en Guper (acumulacion + canje) con el
// token fresco obtenido en el clic de "Pagar". NO bloquea el cierre ante
// errores: el cron reintenta la acumulacion.
import { patch } from "@web/core/utils/patch";
import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";

patch(PaymentScreen.prototype, {
    async validateOrder(isForceValidate) {
        const order = this.currentOrder;
        // Solo si el flujo de "Pagar" corrio (guper_order_ref lo marca): asi no
        // se dispara en devoluciones ni cuando rewardByOrder fallo.
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
