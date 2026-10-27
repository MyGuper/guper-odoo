/** @odoo-module **/
// Odoo 18: el flujo Guper corre al hacer clic en "Pagar" (Order.pay()).
// Siempre re-cotiza rewardByOrder con la canasta actual; maneja saldo /
// sin-saldo / anonimo / sin-identificador; NO bloquea el cobro ante errores.
import { patch } from "@web/core/utils/patch";
import { Order } from "@point_of_sale/app/store/models";
import { makeAwaitable } from "@point_of_sale/app/store/make_awaitable_dialog";
import { GuperPinPopup } from "@guper_pos_cashback/app/pin_popup/pin_popup";
import { GuperAmountPopup } from "@guper_pos_cashback/app/amount_popup/amount_popup";

patch(Order.prototype, {
    async pay() {
        await this._guperPay();
        return super.pay(...arguments);
    },

    _guperOrderRef() {
        return this.uuid || this.name || this.uid;
    },

    _guperFmt(cents) {
        try {
            return this.pos.env.utils.formatCurrency((cents || 0) / 100);
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

    // Total de la linea CON impuesto (despues de descuento). En Odoo 17/18
    // el metodo canonico es get_price_with_tax(); fallback al neto si no
    // existe (no deberia en 18, pero protege contra future point-releases).
    _guperLineWithTax(l) {
        if (typeof l.get_price_with_tax === "function") {
            return l.get_price_with_tax();
        }
        return (l.get_unit_price() || 0) * l.get_quantity();
    },

    _guperItems() {
        return this.get_orderlines()
            .filter((l) => l.get_quantity() > 0 && (l.get_unit_price() || 0) >= 0)
            .map((l) => {
                const p = l.get_product();
                const qty = l.get_quantity() || 1;
                const lineWithTax = this._guperLineWithTax(l);
                return {
                    id: p.default_code || String(p.id),
                    name: p.display_name,
                    quantity: Math.round(qty),
                    price: Math.round((lineWithTax / qty) * 100),
                    productId: String(p.id),
                };
            });
    },

    async _guperPay() {
        const services = this.pos.env.services;
        const notification = services.notification;
        const dialog = services.dialog;
        const partner = this.get_partner();
        const orderRef = this._guperOrderRef();

        const items = this._guperItems();
        if (!items.length) {
            return;
        }

        // 1) rewardByOrder con la canasta ACTUAL (cliente o anonimo).
        let quote;
        try {
            quote = await this._guperCall("/guper/redeem/start", {
                order_uuid: orderRef,
                config_id: this.pos.config.id,
                partner_id: partner ? partner.id : false,
                items: items,
            });
        } catch (e) {
            notification.add("Guper: " + (e.message || "error"), { type: "danger" });
            return;
        }

        this.guper_order_ref = orderRef;
        this.guper_redeem_amount = 0;
        this._guperResetDiscount();

        const redeemable = quote.redeemable_max || 0;
        const accumulating = quote.accumulating || 0;

        // 2a) Cliente con campo identificador faltante -> no acumula.
        if (quote.missing_id_field) {
            const labels = { phone: "teléfono", email: "email", document: "documento" };
            const f = labels[quote.missing_id_field] || quote.missing_id_field;
            notification.add(
                "El cliente no acumulará: falta " + f + " registrado.",
                { type: "warning" }
            );
            return;
        }
        // 2b) Anonimo (sin cliente) -> aviso; se registra igual (client null).
        if (quote.is_anonymous || !partner) {
            notification.add(
                "Cliente anónimo: dejará de acumular " + this._guperFmt(accumulating),
                { type: "warning" }
            );
            return;
        }
        // 2c) Con cliente sin saldo -> aviso de acumulacion.
        if (redeemable <= 0) {
            notification.add("Acumulará " + this._guperFmt(accumulating), {
                type: "info",
            });
            return;
        }

        // 2d) Con saldo -> primero MONTO (decidir), luego PIN, luego descuento.
        const amount = await makeAwaitable(dialog, GuperAmountPopup, {
            balanceCents: quote.balance_total || 0,
            redeemableCents: redeemable,
        });
        if (!amount) {
            notification.add("Acumulará " + this._guperFmt(accumulating), {
                type: "info",
            });
            return;
        }
        const pinOk = await makeAwaitable(dialog, GuperPinPopup, {
            orderUuid: orderRef,
            call: (path, params) => this._guperCall(path, params),
        });
        if (!pinOk) {
            notification.add(
                "Canje cancelado (PIN). Acumulará " + this._guperFmt(accumulating),
                { type: "info" }
            );
            return;
        }

        this._guperApplyDiscount(quote, amount);
        this.guper_redeem_amount = amount;
        notification.add("Cashback aplicado", { type: "success" });
    },

    _guperGetDiscount(l) {
        return typeof l.get_discount === "function" ? l.get_discount() : (l.discount || 0);
    },

    _guperResetDiscount() {
        for (const l of this.get_orderlines()) {
            if (l.guper_discount_pct) {
                l.set_discount(Math.max(0, this._guperGetDiscount(l) - l.guper_discount_pct));
                l.guper_discount_pct = 0;
            }
        }
    },

    _guperApplyDiscount(quote, amount) {
        const lines = this.get_orderlines().filter(
            (l) => l.get_quantity() > 0 && (l.get_unit_price() || 0) >= 0
        );
        const grossOf = (l) => this._guperLineWithTax(l);
        const rFull = quote.redeemable_full || amount;
        const factor = rFull > 0 ? amount / rFull : 0;
        const valueByItem = {};
        (quote.redeemable_items || []).forEach((it) => {
            valueByItem[String(it.id)] = it.value;
        });
        const applyOne = (l, pct) => {
            l.set_discount(Math.min(100, this._guperGetDiscount(l) + pct));
            l.guper_discount_pct = pct;
        };

        let applied = false;
        for (const l of lines) {
            const p = l.get_product();
            const value = valueByItem[p.default_code || String(p.id)];
            const gross = grossOf(l);
            if (!value || gross <= 0) {
                continue;
            }
            applyOne(l, (((value * factor) / 100) / gross) * 100);
            applied = true;
        }
        if (!applied) {
            const grossTotal = lines.reduce((s, l) => s + grossOf(l), 0);
            if (grossTotal > 0) {
                const pct = ((amount / 100) / grossTotal) * 100;
                lines.forEach((l) => applyOne(l, pct));
            }
        }
    },
});
