/** @odoo-module **/
// Odoo 19: el flujo Guper corre al hacer clic en "Pagar" (PosStore.pay()).
// Siempre re-cotiza rewardByOrder con la canasta actual; maneja saldo /
// sin-saldo / anonimo / sin-identificador; NO bloquea el cobro ante errores.
import { patch } from "@web/core/utils/patch";
import { PosStore } from "@point_of_sale/app/services/pos_store";
import { makeAwaitable } from "@point_of_sale/app/utils/make_awaitable_dialog";
import { GuperPinPopup } from "@guper_pos_cashback/app/pin_popup/pin_popup";
import { GuperAmountPopup } from "@guper_pos_cashback/app/amount_popup/amount_popup";

patch(PosStore.prototype, {
    async pay() {
        await this._guperPay();
        return super.pay(...arguments);
    },

    _guperFmt(cents) {
        try {
            return this.env.utils.formatCurrency((cents || 0) / 100);
        } catch (e) {
            return ((cents || 0) / 100).toFixed(2);
        }
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

    _guperItems(order) {
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

    async _guperPay() {
        const order = this.getOrder();
        if (!order) {
            return;
        }
        const items = this._guperItems(order);
        if (!items.length) {
            return; // sin articulos positivos (devolucion / vacio)
        }
        const partner = order.getPartner();
        const orderRef = order.uuid;

        // 1) rewardByOrder con la canasta ACTUAL (cliente o anonimo).
        let quote;
        try {
            quote = await this._guperCall("/guper/redeem/start", {
                order_uuid: orderRef,
                config_id: this.config.id,
                partner_id: partner ? partner.id : false,
                items: items,
            });
        } catch (e) {
            this.notification.add("Guper: " + (e.message || "error"), { type: "danger" });
            return; // no bloquea el cobro
        }

        order.guper_order_ref = orderRef;
        order.guper_redeem_amount = 0;
        this._guperResetDiscount(order);

        const redeemable = quote.redeemable_max || 0;
        const accumulating = quote.accumulating || 0;

        // 2a) Cliente seleccionado pero SIN el campo identificador -> no acumula.
        if (quote.missing_id_field) {
            const labels = { phone: "teléfono", email: "email", document: "documento" };
            const f = labels[quote.missing_id_field] || quote.missing_id_field;
            this.notification.add("El cliente no acumulará: falta " + f + " registrado.", {
                type: "warning",
            });
            return;
        }
        // 2b) Anonimo (sin cliente) -> aviso; se registra igual (client null).
        if (quote.is_anonymous || !partner) {
            this.notification.add(
                "Cliente anónimo: dejará de acumular " + this._guperFmt(accumulating),
                { type: "warning" }
            );
            return;
        }
        // 2c) Con cliente sin saldo -> aviso de acumulacion.
        if (redeemable <= 0) {
            this.notification.add("Acumulará " + this._guperFmt(accumulating), {
                type: "info",
            });
            return;
        }

        // 2d) Con saldo -> primero MONTO (decidir), luego PIN, luego descuento.
        const amount = await makeAwaitable(this.dialog, GuperAmountPopup, {
            balanceCents: quote.balance_total || 0,
            redeemableCents: redeemable,
        });
        if (!amount) {
            this.notification.add("Acumulará " + this._guperFmt(accumulating), {
                type: "info",
            });
            return;
        }
        const pinOk = await makeAwaitable(this.dialog, GuperPinPopup, {
            orderUuid: orderRef,
            call: (path, params) => this._guperCall(path, params),
        });
        if (!pinOk) {
            this.notification.add(
                "Canje cancelado (PIN). Acumulará " + this._guperFmt(accumulating),
                { type: "info" }
            );
            return;
        }

        this._guperApplyDiscount(order, quote, amount);
        order.guper_redeem_amount = amount;
        this.notification.add("Cashback aplicado", { type: "success" });
    },

    _guperResetDiscount(order) {
        for (const l of order.getOrderlines()) {
            if (l.guper_discount_pct) {
                l.setDiscount(Math.max(0, (l.discount || 0) - l.guper_discount_pct));
                l.guper_discount_pct = 0;
            }
        }
    },

    _guperApplyDiscount(order, quote, amount) {
        const lines = order
            .getOrderlines()
            .filter((l) => l.getQuantity() > 0 && (l.price_unit || 0) >= 0);
        const grossOf = (l) => {
            if (l.price_subtotal_incl != null) {
                return l.price_subtotal_incl;
            }
            if (typeof l.getPriceWithTax === "function") {
                return l.getPriceWithTax();
            }
            return (l.price_unit || 0) * l.getQuantity();
        };
        const addDiscount = (l, pct) => {
            l.setDiscount(Math.min(100, (l.discount || 0) + pct));
            l.guper_discount_pct = pct;
        };
        const rFull = quote.redeemable_full || amount;
        const factor = rFull > 0 ? amount / rFull : 0;
        const valueByItem = {};
        (quote.redeemable_items || []).forEach((it) => {
            valueByItem[String(it.id)] = it.value;
        });

        let applied = false;
        for (const l of lines) {
            const value = valueByItem[l.product_id?.default_code || String(l.product_id?.id)];
            const gross = grossOf(l);
            if (!value || gross <= 0) {
                continue;
            }
            addDiscount(l, (((value * factor) / 100) / gross) * 100);
            applied = true;
        }
        if (!applied) {
            const grossTotal = lines.reduce((s, l) => s + grossOf(l), 0);
            if (grossTotal > 0) {
                const pct = ((amount / 100) / grossTotal) * 100;
                lines.forEach((l) => addDiscount(l, pct));
            }
        }
    },
});
